/*
 * Copyright 2018-2020 Unbounded Systems, LLC
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

import {
    createTaskObserver,
    formatUserError,
    isMessageClient,
    isMessageLogger,
    Message,
    MessageClient,
    MessageLogger,
    MessageStreamer,
    MessageStreamServer,
    MessageSummary,
    TaskObserver,
} from "@adpt/utils";
import { PassThrough } from "stream";
import { ObserversThatNeedData } from "../observers";

export interface ApiResponse {
    type: "success" | "error" | string;
    messages: ReadonlyArray<Message>;
    summary: MessageSummary;
}

export type DeployState = DeploySuccess | DeployError;

export interface DeploySuccess extends ApiResponse {
    type: "success";

    domXml: string;
    stateJson: string;
    needsData: ObserversThatNeedData;
    deployID: string;
    mountedOrigStatus: any;
}

export interface DeployError extends ApiResponse {
    type: "error";

    deployID?: string;  // deployID exists if error occurred in act phase
    domXml?: string;
    stateJson?: string;
}

export function isDeploySuccess(val: DeployState): val is DeploySuccess {
    return val.type === "success";
}

export interface WithLogger {
    client?: MessageClient;
    logger?: MessageLogger;
    loggerId?: string;
}

export interface DeployCommonOptions extends WithLogger {
    adaptUrl: string;
    fileName: string;

    debug?: string;
    dryRun?: boolean;
    ignoreDeleteErrors?: boolean;
    projectRoot?: string;
}

export const defaultDeployCommonOptions = {
    debug: "",
    dryRun: false,
    ignoreDeleteErrors: false,
    projectRoot: undefined,
};

async function setupLogger(options: WithLogger): Promise<MessageLogger> {
    const loggerId = options.loggerId || "main";

    if (process.env.ADAPT_OP_FORKED) { // child process
        return new MessageStreamServer(loggerId, {
            outStream: process.stdout,
            interceptStdio: true,
        });
    }

    if (isMessageLogger(options.logger)) return options.logger;
    if (isMessageClient(options.client)) {
        if (!options.client.fromStream) {
            throw new Error(`MessageClient does not support fromStream`);
        }
        const thru = new PassThrough();
        const logger = new MessageStreamServer(loggerId, { outStream: thru });
        options.client.fromStream(thru);
        return logger;
    }

    return new MessageStreamer(loggerId, {
        outStream: process.stdout,
        errStream: process.stderr,
    });
}

export interface DebugFlags {
    [ flag: string ]: true;
}

export function parseDebugString(s: string): DebugFlags {
    const flags: DebugFlags = {};
    s.split(/\s*,\s*/).map((f) => flags[f] = true);
    return flags;
}

export interface OpsSetupOptions extends WithLogger {
    name: string;          // Task name
    description: string;  // Task description
}

export interface OpsSetupInfo {
    logger: MessageLogger;
    taskObserver: TaskObserver;
}

export type OpsFunction<T extends ApiResponse> = (info: OpsSetupInfo) => T | Promise<T>;

export async function withOpsSetup<T extends ApiResponse>(
    options: OpsSetupOptions,
    func: OpsFunction<T>): Promise<T> {

    const logger = await setupLogger(options);
    const taskObserver = createTaskObserver(options.name, {
        logger,
        description: options.description,
    });

    try {
        taskObserver.started();
        const ret = await func({ logger, taskObserver });
        taskObserver.complete();
        return ret;

    } catch (err) {
        const msg = `Error ${options.description}: ${formatUserError(err)}`;
        logger.error(msg);
        taskObserver.failed(msg);
        const ret: ApiResponse = {
            type: "error",
            messages: logger.messages,
            summary: logger.summary,
        };
        return ret as T;
    }
}
