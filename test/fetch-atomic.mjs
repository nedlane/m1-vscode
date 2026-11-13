import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const [script, tool] of [
  ["server", "m1-lsp"],
  ["project", "m1-project"],
  ["lint", "m1-lint"],
  ["fmt", "m1-fmt"],
]) {
  test(
    `${script} preserves installed bytes until verification succeeds`,
    { skip: process.platform === "win32" && "POSIX gh fixture" },
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "m1-fetch-atomic-"));
      try {
        const bin = path.join(root, "bin");
        fs.mkdirSync(bin);
        const out = path.join(root, "out");
        fs.mkdirSync(out);
        const gh = path.join(bin, "gh");
        fs.writeFileSync(
          gh,
          `#!/usr/bin/env node\nconst fs=require('fs');const crypto=require('crypto');const a=process.argv.slice(2);if(a[0]==='release'){const name=a[a.indexOf('--pattern')+1];fs.writeFileSync(a[a.indexOf('--output')+1],name==='SHA256SUMS'?crypto.createHash('sha256').update('REPLACEMENT').digest('hex')+'  '+process.env.FETCH_TEST_ASSET+'\\n':'REPLACEMENT');process.exit(process.env.FETCH_TEST_MODE==='download-failure'?1:0);}if(process.env.FETCH_TEST_MODE==='verification-failure'){console.error('attestation verification failed: digest mismatch');process.exit(1);}process.exit(0);\n`,
          { mode: 0o755 },
        );
        for (const target of [
          "x86_64-unknown-linux-gnu",
          "x86_64-pc-windows-msvc",
        ]) {
          const name = tool + (target.includes("windows") ? ".exe" : "");
          const dest = path.join(out, name);
          for (const exists of [false, true]) {
            for (const mode of [
              "download-failure",
              "verification-failure",
              "success",
            ]) {
              fs.rmSync(dest, { force: true });
              if (exists) fs.writeFileSync(dest, "KNOWN-GOOD", { mode: 0o700 });
              const result = spawnSync(
                process.execPath,
                [
                  `scripts/fetch-${script}.mjs`,
                  "--target",
                  target,
                  "--out",
                  out,
                ],
                {
                  env: {
                    ...process.env,
                    PATH: bin + path.delimiter + process.env.PATH,
                    FETCH_TEST_MODE: mode,
                    FETCH_TEST_ASSET:
                      tool +
                      "-" +
                      target +
                      (target.includes("windows") ? ".exe" : ""),
                  },
                  encoding: "utf8",
                  timeout: 10000,
                },
              );
              assert.equal(
                result.status,
                mode === "success" ? 0 : 1,
                result.stderr,
              );
              if (mode === "success") {
                assert.equal(fs.readFileSync(dest, "utf8"), "REPLACEMENT");
                if (!target.includes("windows"))
                  assert.equal(fs.statSync(dest).mode & 0o777, 0o755);
              } else if (exists) {
                assert.equal(
                  fs.readFileSync(dest, "utf8"),
                  "KNOWN-GOOD",
                  `${mode} must preserve installed bytes`,
                );
                assert.equal(fs.statSync(dest).mode & 0o777, 0o700);
              } else
                assert(
                  !fs.existsSync(dest),
                  `${mode} must not leave rejected bytes installed`,
                );
              assert.deepEqual(
                fs.readdirSync(out),
                fs.existsSync(dest) ? [name] : [],
                "staging files are cleaned",
              );
            }
          }
          fs.rmSync(dest, { force: true });
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
