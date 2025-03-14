/*
 * Copyright 2019-2021 Unbounded Systems, LLC
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

import { debugExec, ensureError, FIXME_NeedsProperType, InternalError, withTmpDir } from "@adpt/utils";
import db from "debug";
import { ExecaReturnValue, Options as ExecaOptions } from "execa";
import fs from "fs-extra";
import ld from "lodash";
import os from "os";
import * as path from "path";
import randomstring from "randomstring";
import shellwords from "shellwords-ts";
import { OmitT, WithPartialT } from "type-ops";
import { isExecaError } from "../common";
import { Config, ContainerStatus, RestartPolicy } from "../Container";
import { Environment, mergeEnvPairs, mergeEnvSimple } from "../env";
import { ImageRefDockerHost, isImageRefDockerhostWithId, mutableImageRef, WithId } from "./image-ref";
import { adaptDockerDeployIDKey } from "./labels";
import {
    DockerBuildOptions,
    DockerContainerProps,
    DockerGlobalOptions,
    File,
    ImageIdString,
    ImageNameString,
    Mount,
    NameTagString,
    RepoDigestString,
} from "./types";

export const debug = db("adapt:cloud:docker");
// Enable with DEBUG=adapt:cloud:docker:out*
export const debugOut = db("adapt:cloud:docker:out");

export const exec = debugExec(debug, debugOut);

export const pickGlobals = (opts: DockerGlobalOptions): DockerGlobalOptions =>
    ld.pick(opts, "dockerHost");

export const defaultDockerHost = process.env.DOCKER_HOST ||
    os.platform() === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";

/**
 * Common version of busybox to use internally.
 * @internal
 */
export const busyboxImage = "busybox:1";

/*
 * Staged build utilities
 */

export async function writeFiles(pwd: string, files: File[]) {
    // Strip any leading slash
    files = files.map((f) => {
        return f.path.startsWith("/") ?
            { path: f.path.slice(1), contents: f.contents } :
            f;
    });
    // Make any directories required
    const dirs = ld.uniq(files
        .map((f) => path.dirname(f.path))
        .filter((d) => d !== "."));
    await Promise.all(dirs.map(async (d) => fs.mkdirp(path.resolve(pwd, d))));

    await Promise.all(files.map(async (f) => {
        const contents = ld.isString(f.contents) ? Buffer.from(f.contents) : f.contents;
        return fs.writeFile(path.resolve(pwd, f.path), contents);
    }));
}

export async function buildFilesImage(files: File[], opts: BuildFilesImageOptions) {
    const dockerfile = `
        FROM scratch
        COPY . /
        `;
    return withTmpDir(async (dir) => {
        await writeFiles(dir, files);
        return dockerBuild("-", dir, {
            ...pickGlobals(opts),
            forceRm: true,
            imageName: "adapt-tmp-files",
            uniqueTag: true,
            stdin: dockerfile,
            deployID: opts.deployID,
        });
    }, { prefix: "adapt-docker-build" });
}

export interface BuildFilesImageOptions extends DockerGlobalOptions {
    /**
     * If set, adds a Docker LABEL to the built image with the DeployID.
     */
    deployID?: string;
}

export async function withFilesImage<T>(files: File[] | undefined,
    opts: BuildFilesImageOptions,
    fn: (img: WithId<ImageRefDockerHost> | undefined) => T | Promise<T>): Promise<T> {

    if (!files || files.length === 0) return fn(undefined);

    const image = await buildFilesImage(files, opts);
    try {
        return await fn(image);
    } finally {
        const { deployID, ...rmOpts } = opts;
        // Only remove what we built. If we tagged the image, just remove
        // the tag and let Docker decide if the actual image is unused.
        // If there's no tag, try delete by ID, but don't warn if that ID
        // has been tagged by someone else.
        const nameOrId = image.nameTag || image.id;
        try {
            await dockerRemoveImage({ nameOrId, ...rmOpts });
        } catch (err) {
            err = ensureError(err);
            if (! /image is referenced in multiple repositories/.test(err.message)) {
                // tslint:disable-next-line: no-console
                console.warn(`Unable to delete temporary Docker image: `, err.message);
            }
        }
    }
}

const buildKitUnsupported = new Map<string | undefined, boolean>();

export interface ExecDockerOptions extends DockerGlobalOptions {
    requestBuildKit?: boolean;
    stdin?: string;
    env?: Environment;
}

/** @internal */
export async function execDocker(argsIn: string[], options: ExecDockerOptions): Promise<ExecaReturnValue> {
    const globalArgs = [];
    if (options.dockerHost) globalArgs.push("-H", options.dockerHost);

    const env = mergeEnvSimple(options.env) || {};
    env.DOCKER_BUILDKIT = options.requestBuildKit &&
        buildKitUnsupported.get(options.dockerHost) !== true ? "1" : "0";

    const args = globalArgs.concat(argsIn);
    const execaOpts: ExecaOptions = {
        all: true,
        input: options.stdin,
        env,
    };

    try {
        return await exec("docker", args, execaOpts);
    } catch (e) {
        if (e.all) {
            if (e.all.includes("buildkit not supported by daemon")) {
                buildKitUnsupported.set(options.dockerHost, true);
                return execDocker(argsIn, options);
            }
        }
        throw e;
    }
}

export const defaultDockerBuildOptions = {
    requestBuildKit: true,
    forceRm: true,
    uniqueTag: false,
};

function collectBuildArgs(opts: DockerBuildOptions): string[] {
    if (!opts.buildArgs) return [];
    const buildArgs = mergeEnvPairs(opts.buildArgs);
    if (!buildArgs) return [];
    const expanded = buildArgs.map((e) => ["--build-arg", `${e.name}=${e.value}`]);
    return ld.flatten(expanded);
}

export async function dockerBuild(
    dockerfile: string,
    contextPath: string,
    options: DockerBuildOptions = {}): Promise<WithId<ImageRefDockerHost>> {

    const opts = { ...defaultDockerBuildOptions, ...options };
    const mRef = mutableImageRef({
        dockerHost: options.dockerHost || "default",
    });

    const args = ["build", "-f", dockerfile];

    if (dockerfile === "-" && !opts.stdin) {
        throw new Error(`dockerBuild: stdin option must be set if dockerfile is "-"`);
    }

    if (opts.forceRm) args.push("--force-rm");
    if (opts.uniqueTag && !opts.imageName) {
        throw new Error(`dockerBuild: imageName must be set if uniqueTag is true`);
    }
    if (opts.imageName) {
        mRef.path = opts.imageName;
        const tag = createTag(opts.imageTag, opts.uniqueTag);
        if (tag) mRef.tag = tag;
        else if (!opts.uniqueTag && !opts.imageTag) mRef.tag = "latest";
        if (!opts.uniqueTag && mRef.nameTag) args.push("-t", mRef.nameTag);
    }
    if (opts.deployID) {
        args.push("--label", `${adaptDockerDeployIDKey}=${opts.deployID}`);
    }
    const buildArgs = collectBuildArgs(opts);
    args.push(...buildArgs);
    args.push(contextPath);

    const cmdRet = await execDocker(args, opts);
    const { stdout, stderr } = cmdRet;

    const id = await idFromBuild(stdout, stderr, opts);
    if (!id) throw new Error("Could not extract image sha\n" + stdout + "\n\n" + stderr);
    mRef.id = id;

    if (opts.uniqueTag) {
        const prevId = opts.prevUniqueNameTag && await dockerImageId(opts.prevUniqueNameTag, opts);
        if (prevId === id) mRef.nameTag = opts.prevUniqueNameTag; // prev points to current id
        else {
            if (!mRef.nameTag) throw new InternalError(`nameTag not set`);
            await dockerTag({
                existing: id,
                newTag: mRef.nameTag,
                ...pickGlobals(opts),
            });
        }
    }

    const ret = mRef.freeze();
    if (!isImageRefDockerhostWithId(ret)) {
        throw new InternalError(`Built image reference '${mRef.ref}' is not ` +
            `a valid dockerhost reference with ID`);
    }

    return ret;
}

async function idFromBuild(stdout: string, stderr: string, opts: DockerGlobalOptions) {
    let match = /^Successfully built ([0-9a-zA-Z]+)$/mg.exec(stdout);
    if (match && match[1]) {
        // Legacy docker build output
        const id = await dockerImageId(match[1], opts);
        if (id == null) throw new Error(`Built image ID not found`);
        return id;
    }

    match = /writing image (sha256:[0-9a-f]+) /m.exec(stderr);
    if (match && match[1]) {
        // BuildKit output
        return match[1];
    }
    return null;
}

/**
 * Fetch the image id for a Docker image
 *
 * @internal
 */
export async function dockerImageId(name: string, opts: DockerGlobalOptions = {}): Promise<ImageIdString | undefined> {
    try {
        const inspect = await dockerInspect([name], { type: "image", ...opts });
        if (inspect.length > 1) throw new Error(`Multiple images found`);
        if (inspect.length === 0) return undefined;

        return inspect[0].Id;

    } catch (err) {
        throw new Error(`Error getting image id for ${name}: ${err.message}`);
    }
}

export interface DockerTagOptions extends DockerGlobalOptions {
    existing: ImageNameString | ImageIdString;
    newTag: NameTagString;
}
export async function dockerTag(options: DockerTagOptions) {
    const { existing, newTag } = options;
    await execDocker(["tag", existing, newTag], options);
}

export interface DockerRemoveImageOptions extends DockerGlobalOptions {
    nameOrId: ImageNameString | ImageIdString;
    force?: boolean;
}

const dockerRemoveImageDefaults = {
    force: false,
};

export async function dockerRemoveImage(options: DockerRemoveImageOptions) {
    const opts = { ...dockerRemoveImageDefaults, ...options };

    const args = ["rmi"];
    if (opts.force) args.push("--force");
    args.push(opts.nameOrId);

    await execDocker(args, opts);
}

export function createTag(baseTag: string | undefined, appendUnique: boolean): string | undefined {
    if (!baseTag && !appendUnique) return undefined;
    let tag = baseTag || "";
    if (baseTag && appendUnique) tag += "-";
    if (appendUnique) {
        tag += randomstring.generate({
            length: 8,
            charset: "alphabetic",
            readable: true,
            capitalization: "lowercase",
        });
    }
    return tag;
}

export interface InspectReport extends ContainerStatus { }
export interface NetworkInspectReport {
    Id: string;
    Created: string;
    Name: string;
    Driver: string;
    Scope: "local" | string;
    EnableIPv6: boolean;
    IPAM: {
        Driver: string,
        Options: null | FIXME_NeedsProperType;
        Config: FIXME_NeedsProperType[];
    };
    Internal: boolean;
    Attachable: boolean;
    Ingress: boolean;
    ConfigFrom: {
        Network: string;
    };
    ConfigOnly: boolean;
    Containers: {
        [id: string]: {
            Name: string;
            EndpointId: string;
            MacAddress: string; //In xx:yy:zz:aa:bb:cc form
            IPv4Address: string; //In x.y.z.a/n form
            IPv6Address: string; //Can be empty
        }
    };
    Options: {
        [name: string]: string; //Values here are always strings
    };
}

export interface ImageInspectReport {
    Id: string;
    Config: Config;
    [key: string]: FIXME_NeedsProperType;
}

export interface DockerInspectOptions extends DockerGlobalOptions {
    type?: "container" | "image" | "network";
}

/**
 * Run docker inspect and return the parsed output
 *
 * @internal
 */
export async function dockerInspect(namesOrIds: string[], opts: { type: "image" } & DockerInspectOptions):
    Promise<ImageInspectReport[]>;
export async function dockerInspect(namesOrIds: string[], opts: { type: "network" } & DockerInspectOptions):
    Promise<NetworkInspectReport[]>;
export async function dockerInspect(namesOrIds: string[], opts: { type: "container" } & DockerInspectOptions):
    Promise<InspectReport[]>;
export async function dockerInspect(namesOrIds: string[], opts?: DockerInspectOptions):
    Promise<InspectReport[] | NetworkInspectReport[] | ImageInspectReport[]>;
export async function dockerInspect(namesOrIds: string[], opts: DockerInspectOptions = {}):
    Promise<InspectReport[] | NetworkInspectReport[] | ImageInspectReport[]> {
    const execArgs = ["inspect"];
    if (opts.type) execArgs.push(`--type=${opts.type}`);
    let inspectRet: ExecaReturnValue<string>;
    try {
        inspectRet = await execDocker([...execArgs, ...namesOrIds], opts);
    } catch (e) {
        if (isExecaError(e) && e.stderr.startsWith("Error: No such")) {
            inspectRet = e;
        } else throw e;
    }
    try {
        const inspect = JSON.parse(inspectRet.stdout);
        if (!Array.isArray(inspect)) throw new Error(`docker inspect result is not an array`);
        return inspect;
    } catch (err) {
        throw new Error(`Error inspecting docker objects ${namesOrIds}: ${err.message}`);
    }
}

export type NetworkReport = NetworkInspectReport[];

/**
 * Return a list of all network names
 *
 * @internal
 */
export async function dockerNetworkLs(opts: DockerGlobalOptions): Promise<string[]> {
    const result = await execDocker(["network", "ls", "--format", "{{json .Name}}"], opts);
    const ret: string[] = [];
    for (const line of result.stdout.split("\n")) {
        ret.push(JSON.parse(line));
    }
    return ret;
}

/**
 * Return all networks and their inspect reports
 *
 * @internal
 */
export async function dockerNetworks(opts: DockerGlobalOptions): Promise<NetworkReport> {
    const networks = await dockerNetworkLs(opts);
    return dockerInspect(networks, { ...opts, type: "network" });
}

/**
 * Run docker stop
 *
 * @internal
 */
export async function dockerStop(namesOrIds: string[], opts: DockerGlobalOptions): Promise<void> {
    const args = ["stop", ...namesOrIds];
    await execDocker(args, opts);
}

/**
 * Run docker rm
 *
 * @internal
 */
export async function dockerRm(namesOrIds: string[], opts: DockerGlobalOptions): Promise<void> {
    const args = ["rm", ...namesOrIds];
    await execDocker(args, opts);
}

/**
 * Options for {@link docker.dockerRun}
 *
 * @internal
 */
export interface DockerRunOptions extends OmitT<WithPartialT<DockerContainerProps, "dockerHost">, "networks"> {
    background?: boolean;
    name?: string;
    image: ImageNameString;
    network?: string;
}

const defaultDockerRunOptions = {
    background: true,
    privileged: false,
};

/**
 * Run a container via docker run
 *
 * @internal
 */
export async function dockerRun(options: DockerRunOptions) {
    const opts = { ...defaultDockerRunOptions, ...options };
    const {
        background, labels, mounts, name,
        portBindings, ports, privileged, restartPolicy,
    } = opts;
    const args: string[] = ["run"];

    if (privileged) args.push("--privileged");
    if (background) args.push("-d");
    if (name) args.push("--name", name);
    if (labels) {
        for (const l of Object.keys(labels)) {
            args.push("--label", `${l}=${labels[l]}`); //FIXME(manishv) better quoting/format checking here
        }
    }
    if (opts.autoRemove) args.push("--rm");
    if (portBindings) {
        const portArgs = Object.keys(portBindings).map((k) => `-p${portBindings[k]}:${k}`);
        args.push(...portArgs);
    }
    if (opts.stopSignal) args.push("--stop-signal", opts.stopSignal);

    if (opts.network !== undefined) {
        args.push("--network", opts.network);
    }

    if (opts.environment !== undefined) {
        const envPairs = mergeEnvPairs(opts.environment);
        if (envPairs) {
            for (const evar of envPairs) {
                args.push("-e", `${evar.name}=${evar.value}`);
            }
        }
    }

    if (ports) args.push(...ports.map((p) => `--expose=${p}`));

    args.push(...restartPolicyArgs(restartPolicy));

    if (mounts) args.push(...ld.flatten(mounts.map(mountArgs)));

    args.push(opts.image);
    if (typeof opts.command === "string") args.push(...shellwords.split(opts.command));
    if (Array.isArray(opts.command)) args.push(...opts.command);

    return execDocker(args, opts);
}

function restartPolicyArgs(policy: RestartPolicy | undefined) {
    if (!policy) return [];
    switch (policy.name) {
        case undefined:
        case "" as RestartPolicy["name"]:
        case "Never":
            return [];
        case "Always":
            return ["--restart=always"];
        case "UnlessStopped":
            return ["--restart=unless-stopped"];
        case "OnFailure":
            const max = policy.maximumRetryCount ? ":" + policy.maximumRetryCount : "";
            return [`--restart=on-failure${max}`];
        default:
            throw new Error(`Invalid RestartPolicy name '${policy.name}'`);
    }
}

const stringVal = (key: string) => (val: any) => `${key}=${val}`;

type MountArgTransform = {
    [K in keyof Mount]: (val: Mount[K]) => string;
};
const mountArgTransform: MountArgTransform = {
    type: stringVal("type"),
    source: stringVal("source"),
    destination: stringVal("destination"),
    readonly: (val) => val ? "readonly" : "",
    propagation: stringVal("propagation"),
};

function mountArgs(mount: Mount): string[] {
    const items: string[] = [];

    for (const [k, v] of Object.entries(mount)) {
        const xform = (mountArgTransform as any)[k];
        if (!xform) {
            throw new Error(`Invalid mount property '${k}'`);
        }
        items.push(xform(v));
    }
    return [ "--mount", items.join(",")];
}

/**
 * Attach containers to given networks
 *
 * @internal
 */
export async function dockerNetworkConnect(containerNameOrId: string, networks: string[],
    opts: { alreadyConnectedError?: boolean } & ExecDockerOptions) {
    const optsWithDefs = { alreadyConnectedError: true, ...opts };
    const { alreadyConnectedError, ...execOpts } = optsWithDefs;
    const alreadyConnectedRegex =
        new RegExp(`^Error response from daemon: endpoint with name ${containerNameOrId} already exists in network`);
    for (const net of networks) {
        try {
            await execDocker(["network", "connect", net, containerNameOrId], execOpts);
        } catch (e) {
            if (!alreadyConnectedError && isExecaError(e)) {
                if (alreadyConnectedRegex.test(e.stderr)) continue;
            }
            throw e;
        }
    }
}

/**
 * Detach containers from given networks
 *
 * @internal
 */
export async function dockerNetworkDisconnect(containerNameOrId: string, networks: string[],
    opts: { alreadyDisconnectedError?: boolean } & ExecDockerOptions) {
    const optsWithDefs = { alreadyDisconnectedError: true, ...opts };
    const { alreadyDisconnectedError, ...execOpts } = optsWithDefs;
    for (const net of networks) {
        try {
            await execDocker(["network", "disconnect", net, containerNameOrId], execOpts);
        } catch (e) {
            if (!alreadyDisconnectedError && isExecaError(e)) {
                if (/^Error response from daemon: container [0-9a-fA-F]+ is not connected to network/.test(e.stderr) ||
                    (new RegExp(`^Error response from daemon: network ${net} not found`).test(e.stderr))) {
                    continue;
                }
            }
            throw e;
        }
    }
}

/**
 * Options for dockerPush.
 *
 * @internal
 */
export interface DockerPushOptions extends DockerGlobalOptions {
    nameTag: NameTagString;
}

/**
 * Push an image to a registry
 *
 * @internal
 */
export async function dockerPush(opts: DockerPushOptions): Promise<void> {
    const args: string[] = ["push", opts.nameTag];
    await execDocker(args, opts);
}

/**
 * Options for dockerPull.
 *
 * @internal
 */
export interface DockerPullOptions extends DockerGlobalOptions {
    /**
     * Image to pull.
     * @remarks
     * See {@link docker.ImageNameString} for more details. If the registry
     * portion of imageName is absent, the official Docker registry is
     * assumed.
     */
    imageName: ImageNameString;
}

/**
 * Information about an image that has been successfully pulled from a
 * registry.
 *
 * @internal
 */
export interface DockerPullInfo {
    id: ImageIdString;
    registryDigest: RepoDigestString;
}

/**
 * Push an image to a registry
 *
 * @internal
 */
export async function dockerPull(opts: DockerPullOptions): Promise<DockerPullInfo> {
    const args: string[] = ["pull", opts.imageName];
    const repo = removeTag(opts.imageName);

    const { stdout } = await execDocker(args, opts);

    const m = stdout.match(/Digest:\s+(\S+)/);
    if (!m) throw new Error(`Output from docker pull did not contain Digest. Output:\n${stdout}`);
    const registryDigest = `${repo}@${m[1]}`;

    const info = await dockerInspect([registryDigest], { type: "image", ...pickGlobals(opts) });
    if (info.length !== 1) {
        throw new Error(`Unexpected number of images (${info.length}) match ${registryDigest}`);
    }
    return {
        id: info[0].Id,
        registryDigest,
    };
}

/**
 * Given a *valid* ImageNameString, removes the optional tag and returns only the
 * `[registry/]repo` portion.
 * NOTE(mark): This does not attempt to be a generic parser for all Docker
 * image name strings because there's ambiguity in how to parse that requires
 * context of where it came from or which argument of which CLI it is.
 */
function removeTag(imageName: ImageNameString): ImageNameString {
    const parts = imageName.split(":");
    switch (parts.length) {
        case 1:
            // 0 colons - no tag present
            break;
        case 2:
            // 1 colon - Could be either from hostname:port or :tag
            // If it's hostname:port, then parts[1] *must* include a slash
            // else it's a tag, so dump it.
            if (!parts[1].includes("/")) parts.pop();
            break;
        case 3:
            // 2 colons - last part is the tag
            parts.pop();
            break;
        default:
            throw new Error(`Invalid docker image name '${imageName}'`);
    }
    return parts.join(":");
}
