/*
 * Copyright 2019 Unbounded Systems, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TaskObserver, TaskState } from "@adpt/utils";
import { inspect } from "util";
import { InternalError } from "../error";
import { isFinalDomElement } from "../jsx";
import { Deployment } from "../server/deployment";
import { DeployOpID, DeployStepID, ElementStatus, ElementStatusMap } from "../server/deployment_data";
import {
    DeployOpStatus,
    DeployStatus,
    DeployStatusExt,
    ExecuteComplete,
    GoalStatus,
    goalToInProgress,
    isFinalStatus,
    isGoalStatus,
    isInProgress,
    isProxying,
    toDeployStatus,
} from "./deploy_types";
import {
    EPNode,
    StatusTracker,
} from "./deploy_types_private";

export interface StatusTrackerOptions {
    deployment: Deployment;
    dryRun: boolean;
    goalStatus: GoalStatus;
    nodes: EPNode[];
    deployOpID: DeployOpID;
    taskObserver: TaskObserver;
}

export async function createStatusTracker(options: StatusTrackerOptions): Promise<StatusTracker> {
    const tracker = new StatusTrackerImpl(options);
    await tracker.initDeploymentStatus();
    return tracker;
}

export class StatusTrackerImpl implements StatusTracker {
    readonly deployment: Deployment;
    readonly dryRun: boolean;
    readonly goalStatus: GoalStatus;
    readonly nodeStatus: Record<DeployStatus, number>;
    readonly nonPrimStatus: Record<DeployStatus, number>;
    readonly deployOpID: DeployOpID;
    readonly primStatus: Record<DeployStatus, number>;
    readonly statMap: Map<EPNode, DeployStatusExt>;
    readonly taskMap: Map<EPNode, TaskObserver>;
    stepID?: DeployStepID;

    constructor(options: StatusTrackerOptions) {
        this.deployment = options.deployment;
        this.deployOpID = options.deployOpID;
        this.dryRun = options.dryRun;
        this.goalStatus = options.goalStatus;

        this.nodeStatus = this.newStatus();
        this.nodeStatus.Waiting = options.nodes.length;

        this.primStatus = this.newStatus();
        this.nonPrimStatus = this.newStatus();

        this.taskMap = new Map<EPNode, TaskObserver>();
        const tGroup = options.taskObserver.childGroup({ serial: false });

        this.statMap = new Map<EPNode, DeployStatusExt>(options.nodes.map((n) => {
            if (n.element) {
                if (isFinalDomElement(n.element)) this.primStatus.Waiting++;
                else this.nonPrimStatus.Waiting++;
                if (shouldTrackStatus(n)) {
                    const id = n.element.id;
                    const trivial = isTrivial(n);
                    const tasks = tGroup.add({ [id]: n.element.componentName },
                        { createOnly: false, trivial });
                    this.taskMap.set(n, tasks[id]);
                }
            }
            return [n, DeployStatusExt.Waiting] as [EPNode, DeployStatusExt];
        }));
    }

    async initDeploymentStatus() {
        if (this.dryRun) return;

        this.stepID = await this.deployment.newStepID(this.deployOpID);
        const deploymentDeployStatus = goalToInProgress(this.goalStatus);

        const elementStatus: ElementStatusMap = {};
        this.statMap.forEach((extStatus, n) => {
            const el = n.element;
            if (el == null) return;
            elementStatus[el.id] = { deployStatus: toDeployStatus(extStatus) };
        });
        await this.deployment.status(this.stepID, {
            deployStatus: deploymentDeployStatus,
            goalStatus: this.goalStatus,
            elementStatus,
        });
    }

    get(n: EPNode) {
        const stat = this.statMap.get(n);
        if (stat === undefined) {
            throw new InternalError(`Unrecognized node: ${inspect(n)}`);
        }
        return stat;
    }

    // Returns true when status was changed, false when node was already
    // in a final state or already in the requested state.
    async set(n: EPNode, statExt: DeployStatusExt, err: Error | undefined,
        description?: string) {
        const oldStat = this.get(n);
        if (statExt === oldStat || isFinalStatus(oldStat)) return false;

        const deployStatus = toDeployStatus(statExt);

        this.statMap.set(n, statExt);
        this.updateCount(n, toDeployStatus(oldStat), deployStatus);

        this.updateTask(n, oldStat, deployStatus, err, description);
        await this.writeStatus(n, err);

        return true;
    }

    isFinal(n: EPNode) {
        return isFinalStatus(this.get(n));
    }

    isActive(n: EPNode) {
        return !isFinalStatus(this.get(n));
    }

    output(n: EPNode, s: string) {
        const task = this.getTask(n);
        if (!task) return;
        task.updateStatus(s);
    }

    async complete(stateChanged: boolean): Promise<ExecuteComplete> {
        if (this.nodeStatus.Initial > 0) {
            throw new InternalError(`Nodes should not be in Initial state ${JSON.stringify(this.nodeStatus)}`);
        }

        const atGoal = this.nodeStatus.Deployed + this.nodeStatus.Destroyed;
        const deploymentStatus =
            (this.nodeStatus.Failed > 0) ? DeployStatus.Failed :
            (atGoal === this.statMap.size) ? this.goalStatus :
            stateChanged ? DeployOpStatus.StateChanged :
            goalToInProgress(this.goalStatus);

        if (this.stepID != null) {
            await this.deployment.status(this.stepID, { deployStatus: deploymentStatus });
        }

        return {
            deploymentStatus,
            nodeStatus: this.nodeStatus,
            nonPrimStatus: this.nonPrimStatus,
            primStatus: this.primStatus,
            stateChanged,
        };
    }

    debug(getId: (n: EPNode) => string) {
        const entries = [...this.statMap]
            .map(([n, stat]) => `  ${(getId(n) as any).padEnd(20)} => ${stat}`)
            .join("\n");
        return `StatusTracker {\n${entries}\n}`;
    }

    private getTask(n: EPNode) {
        if (!shouldTrackStatus(n)) return undefined;
        const task = this.taskMap.get(n);
        if (!task) {
            throw new InternalError(`No task observer found for node (${n.element && n.element.id})`);
        }
        return task;
    }

    private async writeStatus(n: EPNode, err: Error | undefined) {
        if (n.element == null || this.stepID == null) return;

        const statExt = this.get(n);
        const deployStatus = toDeployStatus(statExt);
        const s: ElementStatus = { deployStatus };
        if (err) s.error = err.message;
        await this.deployment.elementStatus(this.stepID, { [n.element.id]: s });
    }

    private updateTask(n: EPNode, oldStat: DeployStatusExt, newStat: DeployStatus,
        err: Error | undefined, description: string | undefined) {

        const task = this.getTask(n);
        if (!task) return;

        if (description) task.description = description;

        if (err) return task.failed(err);

        if (this.dryRun) {
            if (isGoalStatus(newStat)) {
                if (task.state === TaskState.Created ||
                    task.state === TaskState.Started) task.skipped();
            }

        } else {
            if (isInProgress(newStat) && !isProxying(oldStat)) {
                if (task.state === TaskState.Created) task.started();
            } else if (isGoalStatus(newStat)) {
                if (task.state === TaskState.Started) task.complete();
            }
        }
    }

    private updateCount(n: EPNode, oldStat: DeployStatus, newStat: DeployStatus) {
        this.nodeStatus[oldStat]--;
        this.nodeStatus[newStat]++;
        if (n.element) {
            if (isFinalDomElement(n.element)) {
                this.primStatus[oldStat]--;
                this.primStatus[newStat]++;
            } else {
                this.nonPrimStatus[oldStat]--;
                this.nonPrimStatus[newStat]++;
            }
        }
    }

    private newStatus(): Record<DeployStatus, number> {
        const stat: any = {};
        Object.keys(DeployStatus).forEach((k) => stat[k] = 0);
        return stat;
    }
}

export function shouldTrackStatus(n: EPNode) {
    return n.element != null;
}

export function isTrivial(n: EPNode) {
    if (n.waitInfo.activeAction) return false;
    if (n.element && n.element.built()) return n.element.deployedWhenIsTrivial;
    return true;
}
