const path = require("path");
const Mocha = require("mocha");
const { glob } = require("glob");

async function run() {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 90000 });
  const testsRoot = __dirname;
  const files = await glob("**/*.test.cjs", { cwd: testsRoot });
  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
  return new Promise((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(`${failures} test(s) failed`)) : resolve(),
    );
  });
}

module.exports = { run };
