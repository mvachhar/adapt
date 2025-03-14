/*
 * Copyright 2019-2020 Unbounded Systems, LLC
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

import should from "should";

import { k8sutils } from "@adpt/testutils";
import ld from "lodash";
import {
    Kubeconfig
} from "../../src/k8s";
import { getKubectl, kubectlGet, kubectlOpManifest } from "../../src/k8s/kubectl";
import { labelKey, Manifest } from "../../src/k8s/manifest_support";
import { mkInstance } from "../run_minikube";
import { makeDeployId } from "../testlib";

const { deleteAll, getAll } = k8sutils;

describe("kubectl utility function tests", function () {
    this.timeout(10 * 1000);

    let kubeconfig: Kubeconfig;
    let client: k8sutils.KubeClient;
    const deployID = makeDeployId("kubectl");
    const testNamespace = "utility-function-test";
    const testNamespaceManifest: Manifest = {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
            name: testNamespace,
        }
    };

    before(async function () {
        this.timeout(mkInstance.setupTimeoutMs);
        this.slow(20 * 1000);
        kubeconfig = await mkInstance.kubeconfig as Kubeconfig;
        client = await mkInstance.client;
    });

    before(async function () {
        this.timeout("10s");
        await getKubectl();
        await kubectlOpManifest("create", {
            kubeconfig,
            manifest: testNamespaceManifest,
        });
    });

    afterEach(async function () {
        this.timeout(20 * 1000);
        if (client) {
            const namespaces = [ "default", testNamespace];
            await deleteAll("pods", { client, deployID, namespaces });
            await deleteAll("services", { client, deployID, namespaces });
        }
    });

    after(async function () {
        this.timeout("1s");
        await kubectlOpManifest("delete", { kubeconfig, manifest: testNamespaceManifest });
    });

    const origManifest: Manifest = {
        apiVersion: "v1",
        kind: "Pod",
        metadata: {
            name: "foo",
            annotations: {
                [labelKey("deployID")]: deployID
            }
        },
        spec: {
            containers: [{
                name: "main",
                image: "busybox",
                command: ["sh", "-c", "Hello Kubectl Tests! && sleep 3600"]
            }],
            terminationGracePeriodSeconds: 0
        }
    };

    async function createOrigResource({ namespace }: { namespace?: string } = {}) {
        const manifest = {
            ...origManifest,
            metadata: {
                ...origManifest.metadata,
                namespace: namespace || origManifest.metadata.namespace,
            }
        };
        const result = await kubectlOpManifest("create", {
            kubeconfig,
            manifest,
        });
        should(result.stderr).empty();
        should(result.stdout).match(/created/);
        should(result.exitCode).equal(0);

        const pods = await getAll("pods", { client, deployID, namespaces: [ namespace ? namespace : "default"] });
        should(pods).be.ok();
        should(pods).length(1);
        should(pods[0]).be.ok();
        should(pods[0].metadata.name).equal(origManifest.metadata.name);
        return manifest;
    }

    it("should create object by manifest and get by name", async () => {
        await createOrigResource();
        const result = await kubectlGet({
            kubeconfig,
            name: origManifest.metadata.name,
            kind: origManifest.kind,
        });
        should(result).be.ok();
        should(result.metadata).be.ok();
        should(result.kind).equal(origManifest.kind);
        should(result.metadata.name).equal(origManifest.metadata.name);
        should(result.status).be.ok();
    });

    it("should create object by manifest and get by name and namespace", async () => {
        const manifest = await createOrigResource({ namespace: testNamespace });
        const result = await kubectlGet({
            kubeconfig,
            name: manifest.metadata.name,
            namespace: manifest.metadata.namespace,
            kind: manifest.kind,
        });
        should(result).be.ok();
        should(result.metadata).be.ok();
        should(result.kind).equal(origManifest.kind);
        should(result.metadata.name).equal(origManifest.metadata.name);
        should(result.status).be.ok();
    });

    it("Should delete object by manifest", async () => {
        await createOrigResource();
        const result = await kubectlOpManifest("delete", {
            kubeconfig,
            manifest: origManifest
        });
        should(result.stderr).empty();
        should(result.stdout).match(/deleted/);
        should(result.exitCode).equal(0);
    });

    it("Should update object by manifest", async () => {
        const origResult = await kubectlOpManifest("apply", {
            kubeconfig,
            manifest: origManifest
        });
        should(origResult.stderr).empty();
        should(origResult.stdout).match(/created/);
        should(origResult.exitCode).equal(0);

        const origPods = await getAll("pods", { client, deployID });
        should(origPods).be.ok();
        should(origPods).length(1);
        should(origPods[0]).be.ok();
        should(origPods[0].metadata.name).equal(origManifest.metadata.name);

        const newManifest = ld.cloneDeep(origManifest);
        (newManifest.spec as any).containers[0].image = "alpine";

        const result = await kubectlOpManifest("apply", {
            kubeconfig,
            manifest: newManifest
        });
        should(result.stderr).empty();
        should(result.stdout).match(/configured/);
        should(result.exitCode).equal(0);

        const pods = await getAll("pods", { client, deployID });
        should(pods).be.ok();
        should(pods).length(1);
        should(pods[0]).be.ok();
        should(pods[0].metadata.name).equal(origManifest.metadata.name);
        should(pods[0].spec).be.ok();
        should(pods[0].spec.containers).length(1);
        should(pods[0].spec.containers[0]).be.ok();
        should(pods[0].spec.containers[0].image).equal((newManifest.spec as any).containers[0].image);
    });
});
