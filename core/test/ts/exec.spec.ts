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

import { mochaTmpdir as tmpdir } from "@adpt/testutils";
import { yarn } from "@adpt/utils";
import should from "should";

import * as path from "path";
import { pkgRootDir } from "../testlib";

import { ProjectRunError } from "../../src/error";
import { isNullStack } from "../../src/stack";
import {
    createAdaptContext,
    exec,
    execString,
    MemFileHost,
} from "../../src/ts";

const projectsRoot = path.join(pkgRootDir, "test_projects");

describe("Exec basic tests", function () {
    this.slow(1000);

    it("Should execute a string", function () {
        this.timeout(5000);

        const source = `
            class Test<T> {
                constructor(public x: T) {}
                y() {
                    return this.x.toString();
                }
            }

            const mytest = new Test(5);
            mytest.y(); // final value returns to caller
        `;
        const ret = execString(source);
        should(ret).equal("5");
    });

    it("Should import a builtin module", function () {
        this.timeout(5000);

        const source = `
            import * as util from "util";
            util.inspect({test: 5});
        `;
        const ret = execString(source);
        should(ret).equal("{ test: 5 }");
    });

    it("Should modify context state", function () {
        this.timeout(5000);

        const source = `
            (global as any).foo.bar = 1;
        `;
        const context = { foo: {} };
        execString(source, context);
        should(context.foo).eql({bar: 1});
    });

    it("Should throw ProjectRunError upon error", function () {
        this.timeout(5000);

        const source =
            `// Comment line\n` +
            `throw new Error("This is my error");\n`;
        const shortStack =
            `[root].ts:2\n` +
            `throw new Error("This is my error");\n` +
            `^\n` +
            `\n` +
            `Error: This is my error\n` +
            `    at [root].ts:2:7`;

        const context = {};
        try {
            execString(source, context);
            throw new Error(`execString should have thrown`);
        } catch (err) {
            should(err).be.instanceof(ProjectRunError);
            should(err.message).equal("Error executing Adapt project: This is my error");
            should(err.projectStack).equal(shortStack);
            should(err.fullStack).startWith(shortStack);
            should(err.fullStack).match(/VmContext.run/);
        }
    });

});

function doubleBackslash(p: string) {
    return p.replace(/\\/g, "\\\\");
}

describe("Exec module tests", function () {
    this.timeout(10000);
    const copyDir = path.resolve(projectsRoot, "import_module");
    tmpdir.each("adapt-exec", {copy: copyDir});

    it("Should require relative json file", () => {
        const projDir = process.cwd();
        const orig = {
            avalue: 1,
            another: "foo"
        };
        const host = MemFileHost("/", projDir);

        const source = `
            declare var require: any;
            const ctxObj = require("./stuff.json");
            ctxObj;
        `;

        host.writeFile("stuff.json", JSON.stringify(orig));
        host.writeFile("index.ts", source);

        const ret = exec(path.join(projDir, "index.ts"), {host});
        should(ret).eql(orig);
    });

    it("Should require absolute json file", () => {
        const projDir = process.cwd();
        const orig = {
            avalue: 1,
            another: "foo"
        };
        const host = MemFileHost("/", projDir);

        const source = `
            declare var require: any;
            const ctxObj = require("${doubleBackslash(projDir)}/stuff.json");
            ctxObj;
        `;

        host.writeFile("stuff.json", JSON.stringify(orig));
        host.writeFile("index.ts", source);

        const ret = exec(path.join(projDir, "index.ts"), {host});
        should(ret).eql(orig);
    });

    it("Should import a node module", async () => {
        const projDir = process.cwd();
        await yarn.install();
        const index = path.resolve(projDir, "index.ts");
        const host = MemFileHost("/", projDir);
        const ret = exec(index, {host});
        should(ret).equal("test_camel");
    });
});

describe("adaptContext Tests", () => {
    it("Should add null stack into adapt context", () => {
        const context = createAdaptContext(path.resolve("."));
        const stacks = context.adaptStacks;
        const nullStack = stacks.get("(null)");
        if (nullStack === undefined) throw should(nullStack).not.Undefined();
        should(isNullStack(nullStack)).True();
    });
});
