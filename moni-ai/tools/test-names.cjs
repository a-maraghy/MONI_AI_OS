/**
 * The assistant's names (lib/names.js): shown as MINT AI, and during the
 * transition every "is this name us?" check accepts the old MONI AI (and
 * MONI Bot) too, as well as the internal id moni-ai. Also: a mission step
 * given to the assistant by any of its names is stored as "moni-ai".
 *
 *     node moni-ai/tools/test-names.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const names = require(path.join(__dirname, "..", "lib", "names.js"));
const { Ledger } = require(path.join(__dirname, "..", "lib", "ledger.js"));
const { Missions } = require(path.join(__dirname, "..", "lib", "missions.js"));

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + detail + ")" : ""));
}

check("the display name is MINT AI", names.DISPLAY_NAME === "MINT AI");
check("the old names are MONI AI and MONI Bot", names.OLD_NAMES.includes("MONI AI") && names.OLD_NAMES.includes("MONI Bot"));
for (const n of ["MINT AI", "MONI AI", "mint ai", "Moni Ai", "moni-ai", "mint-ai", "MINT AI [a1b2c3]", "  MONI AI  ", "MONI Bot", "moni_bot"])
  check(`"${n}" is the assistant`, names.isSelfName(n) === true);
for (const n of ["MONI Agent OS", "Odoo 19 VPS setup", "mint", "moni", "MINT AI helper", "", null, undefined])
  check(`"${n}" is not the assistant`, names.isSelfName(n) === false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moni-names-"));
const M = new Missions(new Ledger(path.join(tmp, "ledger.db")));
const m = M.create({
  title: "Rename",
  goal: "g",
  steps: [{ title: "a", target: "MINT AI" }, { title: "b", target: "MONI AI" }, { title: "c", target: "moni-ai" }, { title: "d", target: "MONI Agent OS" }],
  actor: "moni-ai",
});
check("steps given to MINT AI / MONI AI are stored as moni-ai", m.steps.map((s) => s.target).join("|") === "moni-ai|moni-ai|moni-ai|MONI Agent OS", m.steps.map((s) => s.target).join("|"));
const upd = M.updateStep(m.id, 4, { target: "MINT AI" });
check("re-targeting a step to MINT AI stores moni-ai", upd.steps[3].target === "moni-ai", upd.steps[3].target);

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
