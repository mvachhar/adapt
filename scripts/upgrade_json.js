#!/usr/bin/env node

/*
 * Copyright 2020 Unbounded Systems, LLC
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


const { isObject } = require("@adpt/utils");
const S3 = require('aws-sdk/clients/s3');
const chalk = require("chalk").default;
const { Command } = require("commander");
const diff = require("diff");
const indent = require("indent-string");
const { cloneDeep, isEqual } = require("lodash");
const { format } = require("util");
 
// Set credentials and Region
const s3 = new S3({ region: 'us-west-2' });

const defaultBucket = "adapt-public";
const defaultKey = "upgrade-check.json";

// From semver.org
const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;


Command.prototype.globalArgs = function globalArgs() {
    this.option("--bucket <bucket>", "Name of the bucket where the JSON file is located", defaultBucket)
    this.option("--key <key>", "Key where the JSON file is located", defaultKey)
    return this;
}

const program = new Command();

program
    .command("add <version>")
    .description("Add a new version to upgrade-check.json")
    .globalArgs()
    .option("--comment <comment>", "A comment to store with this update")
    .option("--current", "Set this version to be the most current version for the channel")
    .option("--desc <description>", "Description text for this version")
    .option("--init", "Initializes a new S3 object and adds the version")
    .option("--securityFixes", "Mark this version as containing security fixes")
    .action(cliHandler(commandAdd));

program
    .command("delete <version>")
    .description("Delete a version from upgrade-check.json")
    .globalArgs()
    .option("--comment <comment>", "A comment to store with this update")
    .action(cliHandler(commandDelete));

program
    .command("show")
    .description("Show information from the upgrade check file")
    .globalArgs()
    .action(cliHandler(commandShow));

program
    .command("update <version>")
    .description("Update a version in upgrade-check.json")
    .globalArgs()
    .option("--comment <comment>", "A comment to store with this update")
    .option("--current", "Set this version to be the most current version for the channel")
    .option("--desc <description>", "Description text for this version")
    .option("--no-desc", "Remove description text for this version")
    .option("--securityFixes", "Mark this version as containing security fixes")
    .option("--no-securityFixes", "Remove the security fixes flag on this version")
    .action(cliHandler(commandUpdate));

program
    .command("history")
    .description("Show version history")
    .globalArgs()
    .action(cliHandler(commandHistory));


program.on("command:*", () => {
    console.error(chalk.bold(`\nInvalid command: ${program.args.join(' ')}\n`));
    program.help(); // Exits
});

function validateVersion(version) {
    if (!semverRegex.test(version)) {
        throw new Error(`Invalid semver version '${version}'`);
    }
}

async function commandAdd(version, cmd) {
    const { bucket, comment, current, desc, init, key, securityFixes } = cmd.opts();
    validateVersion(version);

    const channel = versionChannel(version);
    let orig;

    try {
        orig = await loadUpgradeCheck(bucket, key);
        if (init) throw new Error(`Cannot use --init. Key already exists.`);

    } catch (err) {
        if (err.code !== "NoSuchKey" || !init) throw err;
        orig = {
            name: "@adpt/cli",
            channelCurrent: {},
            versions: {},
        };
    }

    if (version in orig.versions) throw new Error(`Version ${version} already exists`);

    const updated = cloneDeep(orig);

    const entry = { channel };
    if (desc) entry.description = desc;
    if (securityFixes) entry.securityFixes = true;
    updated.versions[version] = entry;

    if (current || init) updated.channelCurrent[channel] = version;

    console.log(`Adding version:\n${diffObjects(orig, updated)}`);

    await storeUpgradeCheck(bucket, key, updated, comment || `Added version ${version}`);
    console.log("Complete");
}

async function commandDelete(version, cmd) {
    const { bucket, comment, key } = cmd.opts();
    validateVersion(version);

    const channel = versionChannel(version);
    let orig;

    orig = await loadUpgradeCheck(bucket, key);

    if (orig.channelCurrent[channel] === version) {
        throw new Error(
            `Cannot delete the current version for channel '${channel}'.\n` +
            `Change the current version for the channel before deleting ` +
            `this version`);
    }

    if (!orig.versions[version]) {
        throw new Error(`Version ${version} not found`);
    }

    const updated = cloneDeep(orig);

    delete updated.versions[version];

    if (isEqual(orig, updated)) {
        console.log(`No changes required`);
        return;
    }

    console.log(`Deleting version:\n${diffObjects(orig, updated)}`);

    await storeUpgradeCheck(bucket, key, updated, comment || `Deleted version ${version}`);
    console.log("Complete");
}

async function commandHistory(cmd) {
    const { bucket, key } = cmd.opts();
    const resp = await s3.listObjectVersions({ Bucket: bucket, Prefix: key }).promise();

    console.log(`#   Modified            Version ID                       Comment`);
    let n = resp.Versions.length - 1;
    for (const ver of resp.Versions) {
        const { LastModified, VersionId } = ver;
        const obj = await s3.getObject({ Bucket: bucket, Key: key, VersionId }).promise();
        const comment = obj.Metadata["version-comment"] || "";
        console.log(`%s %s %s %s`, n.toString().padEnd(3),
            dateString(LastModified), VersionId, comment);
        n--;
    }
}

async function commandShow(cmd) {
    const { bucket, key } = cmd.opts();
    const current = await loadUpgradeCheck(bucket, key);
    console.log(current);
}

async function commandUpdate(version, cmd) {
    const { bucket, comment, current, desc, key, securityFixes } = cmd.opts();
    validateVersion(version);

    const channel = versionChannel(version);
    let orig;

    orig = await loadUpgradeCheck(bucket, key);
    const updated = cloneDeep(orig);

    const entry = updated.versions[version];
    if (!entry) throw new Error(`Version ${version} not found`);


    if (desc) entry.description = desc;
    else if (desc === false) delete entry.description;

    if (securityFixes) entry.securityFixes = true;
    else if (securityFixes === false) delete entry.securityFixes;

    if (current) updated.channelCurrent[channel] = version;

    if (isEqual(orig, updated)) {
        console.log(`No changes required`);
        return;
    }

    console.log(`Updating version:\n${diffObjects(orig, updated)}`);

    await storeUpgradeCheck(bucket, key, updated, comment || `Updated version ${version}`);
    console.log("Complete");
}

function pad(num, len = 2) {
    return num.toString().padStart(len, "0");
}

function dateString(d) {
    const dateStrings = [ d.getMonth() + 1, d.getDate(), d.getHours(),
        d.getMinutes(), d.getSeconds() ].map(n => pad(n));
    return format("%d-%s-%s %s:%s:%s", d.getFullYear(), ...dateStrings);
}

function diffObjects(a, b) {
    const chunks = [];
    const changes = diff.diffJson(a, b);
    changes.forEach((change, i) => {
        const color =
            change.added ? "green" :
            change.removed ? "red" :
            "dim";
        const ind =
            change.added ? "+ " :
            change.removed ? "- " :
            "  ";
        chunks.push(chalk[color](indent(change.value, 1, { indent: ind })));
    });
    return chunks.join("");
}

function versionChannel(version) {
    if (/^\d+\.\d+\.\d+$/.test(version)) return "latest";
    const m = /^\d+\.\d+\.\d+-([^.]+)\./.exec(version);
    if (!m) throw new Error(`Invalid version '${version}'`);
    return m[1];
}

async function getJsonObject(bucket, key) {
    const resp = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    const body = resp.Body.toString();
    return JSON.parse(body);
}

function validateSummary(obj) {
    if (!isObject(obj)) throw new Error(`Response was not a valid object`);
    if (typeof obj.name !== "string") throw new Error(`Invalid name property`);
    if (!obj.name.includes("cli")) throw new Error(`Unrecognized package name`);
    if (!isObject(obj.channelCurrent)) throw new Error(`Invalid channelCurrent property`);
    if (!isObject(obj.versions)) throw new Error(`Invalid versions property`);
}

async function loadUpgradeCheck(bucket, key) {
    const obj = await getJsonObject(bucket, key);
    validateSummary(obj);
    return obj;
}

async function storeUpgradeCheck(bucket, key, obj, comment) {
    validateSummary(obj);
    await s3.putObject({
        Body: JSON.stringify(obj),
        Bucket: bucket,
        Key: key,
        ACL: "public-read",
        ContentType: "application/json",
        Metadata: { "version-comment": comment },
    }).promise();
}

function cliHandler(func) {
    return (...args) => {
        try {
            func(...args)
                .then(() => {
                    process.exit(0);
                })
                .catch((err) => {
                    console.log("ERROR:", err.message);
                    process.exit(1);
                });
        } catch (err) {
            console.log("ERROR:", err);
        }
    };
}

function main() {
    if (process.argv.length <= 2) {
        program.help(); // Exits
    }

    program.parse(process.argv);
}

main();
