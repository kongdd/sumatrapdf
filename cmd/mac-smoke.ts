// Exercise the packaged app through its existing automation socket.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { connect, controlCommands, sendCommand } from "./ng-dbg-control";

const exe = resolve("out/mac/package/stage/SumatraPDF.app/Contents/MacOS/SumatraPDF");
const pdf = resolve("docs/test/zlib.3.pdf");
const pipe = `sumatra-mac-smoke-${process.pid}`;
const child = spawn(exe, ["-for-testing", "-appdata", resolve("out/mac/smoke-settings"), pdf, "-dbg-control", pipe], {
  stdio: "inherit",
});
const exited = new Promise<number | null>((resolve, reject) => {
  child.once("exit", resolve);
  child.once("error", reject);
});
const deadline = setTimeout(() => {
  console.error("Mac PDF smoke test timed out");
  child.kill("SIGKILL");
  process.exit(1);
}, 45000);
let socket: Awaited<ReturnType<typeof connect>> | undefined;
async function command(name: string, args: (string | number)[] = []) {
  const reply = await sendCommand(socket!, controlCommands[name]!, args);
  console.log(name, ...reply);
  if (reply[0] !== 0) throw new Error(`${name} failed: ${reply.join(" ")}`);
  return reply.filter((v) => typeof v === "string").join("\n");
}
try {
  socket = await connect(pipe, 15000);
  await command("WaitRenderIdle", [15000]);
  const tab = await command("TestCurrentTab");
  if (!tab.includes(pdf) || !tab.includes("page=1")) throw new Error("PDF did not open at page 1");
  await command("TestDocumentProperties");
  await command("TestInvokeCommand", ["CmdGoToNextPage"]);
  await command("WaitRenderIdle", [15000]);
  const next = await command("TestCurrentTab");
  if (!next.includes("page=2")) throw new Error("Next page command failed");
  await command("TestInvokeCommand", ["CmdZoomIn"]);
  await command("WaitRenderIdle", [15000]);
  await command("Quit");
  const status = await exited;
  if (status !== 0) throw new Error(`App exited with ${status}`);
  console.log("Mac app smoke test passed: PDF open, render, page navigation, zoom, quit");
} finally {
  socket?.destroy();
  if (child.exitCode === null) child.kill("SIGKILL");
  clearTimeout(deadline);
}
