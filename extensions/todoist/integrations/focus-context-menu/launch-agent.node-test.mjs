import assert from "node:assert/strict";
import { test } from "node:test";
import { launchAgentPlist } from "./launch-agent.mjs";

test("launch agent passes exact private paths as XML arguments, without shell expansion or credentials", () => {
  const value = launchAgentPlist({
    nodePath: "/opt/Node & tools/node",
    servicePath: "/repo/focus/service.mjs",
    configPath: '/private/Personal "Focus"/config.json',
  });
  assert.match(value, /<string>\/opt\/Node &amp; tools\/node<\/string>/);
  assert.match(value, /<string>\/private\/Personal &quot;Focus&quot;\/config.json<\/string>/);
  assert.match(value, /<string>--config<\/string>/);
  assert.doesNotMatch(value, /\/bin\/sh|verificationToken|StandardOutPath/);
});

test("launch agent rejects relative paths that launchd could resolve elsewhere", () => {
  assert.throws(() => launchAgentPlist({ nodePath: "node", servicePath: "/s", configPath: "/c" }));
});
