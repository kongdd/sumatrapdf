// Run against the packaged binary, measuring its RSS separately from the test process.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { deflateSync } from "node:zlib";
import { connect, controlCommands, sendCommand } from "./ng-dbg-control";

const root = resolve("out/mac/functional");
mkdirSync(root, { recursive: true });
const exe = resolve(process.env.SUMATRA_MAC_EXE ?? "out/mac/package/stage/SumatraPDF.app/Contents/MacOS/SumatraPDF");
const report = { checks: [] as { name: string; pass: boolean; detail: unknown }[], memory: [] as Record<string, unknown>[], notes: [
  "RSS includes allocator-retained memory; RSS alone does not establish a leak.",
  "The fixtures exercise vector/text PDFs and synthetic scanned pages; this is not a complete real-world PDF corpus.",
] };
function check(name: string, pass: boolean, detail: unknown) {
  report.checks.push({ name, pass, detail });
  console.log(pass ? "PASS" : "FAIL", name, JSON.stringify(detail));
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function number(text: string, key: string) { return Number(text.match(new RegExp(`(?:^|[ \\n])${key}=([\\d.]+)`))?.[1] ?? NaN); }

async function session(name: string, files: string[], run: (cmd: (name: string, args?: (string | number)[]) => Promise<string>, pid: number) => Promise<void>) {
  const settings = join(root, `settings-${name}`);
  rmSync(settings, { recursive: true, force: true });
  const pipe = `sumatra-functional-${process.pid}-${name}`;
  const child = spawn(exe, ["-for-testing", "-appdata", settings, "-page", "1", ...files, "-dbg-control", pipe], { stdio: "inherit" });
  const exited = new Promise<number | null>((r, reject) => { child.once("exit", r); child.once("error", reject); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 240000);
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    socket = await connect(pipe, 15000);
    const cmd = async (name: string, args: (string | number)[] = []) => {
      const response = await sendCommand(socket!, controlCommands[name]!, args);
      if (response[0] !== 0) throw new Error(`${name}: ${response.join(" ")}`);
      return response.filter((v) => typeof v === "string").join("\n");
    };
    await run(cmd, child.pid!);
    await cmd("Quit");
    check(`${name}: graceful exit`, await exited === 0, child.exitCode);
  } catch (error) {
    check(`${name}: session completed`, false, String(error));
  } finally {
    clearTimeout(deadline);
    socket?.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

const textPdf = resolve("docs/test/zlib.3.pdf");
const bookmarks = resolve("docs/test/bookmarks.pdf");
await session("reading-tabs", [textPdf, bookmarks, textPdf], async (cmd) => {
  await cmd("WaitRenderIdle", [15000]);
  const ui = await cmd("TestUiState");
  check("Duplicate command-line file focuses one tab", number(ui, "tabs") === 2, ui);
  check("Files share one window", number(ui, "windows") === 1, ui);
  const seen = new Set<string>();
  for (let i = 0; i < number(ui, "tabs"); i++) {
    const tab = await cmd("TestCurrentTab");
    seen.add(tab.split(" page=")[0]);
    await cmd("TestInvokeCommand", ["CmdNextTab"]);
    await cmd("WaitRenderIdle", [15000]);
  }
  check("Every unique document is reachable with Next Tab", seen.size === 2, [...seen]);
  // Locate the text PDF regardless of startup sorting or a duplicate tab.
  for (let i = 0; i < number(ui, "tabs"); i++) {
    if ((await cmd("TestCurrentTab")).includes(textPdf)) break;
    await cmd("TestInvokeCommand", ["CmdNextTab"]);
  }
  await cmd("TestInvokeCommand", ["CmdGoToFirstPage"]);
  await cmd("TestInvokeCommand", ["CmdGoToNextPage"]);
  await cmd("WaitRenderIdle", [15000]);
  check("Next page", (await cmd("TestCurrentTab")).includes("page=2"), await cmd("TestCurrentTab"));
  await cmd("TestInvokeCommand", ["CmdGoToPrevPage"]);
  await cmd("WaitRenderIdle", [15000]);
  check("Previous page", (await cmd("TestCurrentTab")).includes("page=1"), await cmd("TestCurrentTab"));
  const beforeZoom = number(await cmd("TestUiState"), "zoom");
  await cmd("TestInvokeCommand", ["CmdZoomIn"]);
  await cmd("WaitRenderIdle", [15000]);
  const afterZoom = number(await cmd("TestUiState"), "zoom");
  check("Zoom changes rendered scale", afterZoom > beforeZoom, { beforeZoom, afterZoom });
  await cmd("TestInvokeCommand", ["CmdFindFirst"]);
  for (const char of "zlib") await cmd("TestInput", ["char", char.codePointAt(0)!]);
  await cmd("TestInput", ["key", 13, 0]);
  await delay(1000);
  const find = await cmd("TestFindUiState");
  check("Search UI accepts text", find.toLowerCase().includes("zlib"), find);
  check("Search finds a text occurrence", number(find, "hitPage") > 0 && number(find, "busy") === 0, find);
  await cmd("TestInput", ["key", 27, 0]);
  await cmd("TestInvokeCommand", ["CmdSelectAll"]);
  check("Select All selects PDF text", number(await cmd("TestUiState"), "selection") === 1, await cmd("TestUiState"));
  await cmd("TestInvokeCommand", ["CmdCopySelection"]);
  const copied = execFileSync("pbpaste", [], { encoding: "utf8" });
  check("Copy Selection reaches the Mac clipboard", copied.toLowerCase().includes("zlib"), { characters: copied.length });
  for (let i = 0; i < number(ui, "tabs"); i++) {
    if ((await cmd("TestCurrentTab")).includes(bookmarks)) break;
    await cmd("TestInvokeCommand", ["CmdNextTab"]);
  }
  await cmd("WaitRenderIdle", [15000]);
  const beforeToc = number(await cmd("TestUiState"), "toc");
  await cmd("TestInvokeCommand", ["CmdToggleBookmarks"]);
  const afterToc = number(await cmd("TestUiState"), "toc");
  check("Bookmarks sidebar toggles", beforeToc !== afterToc, { beforeToc, afterToc });
  const count = number(await cmd("TestUiState"), "tabs");
  await cmd("TestInvokeCommand", ["CmdClose"]);
  check("Close removes one tab", number(await cmd("TestUiState"), "tabs") === count - 1, await cmd("TestUiState"));
  await cmd("TestInvokeCommand", ["CmdReopenLastClosedFile"]);
  await cmd("WaitRenderIdle", [15000]);
  check("Reopen restores a tab", number(await cmd("TestUiState"), "tabs") === count, await cmd("TestUiState"));
});

// One 2400x3200 RGB page: small compressed file, substantial decoded image memory.
function scannedPdf(): Buffer {
  const width = 2400, height = 3200;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 3;
    const v = ((x >> 5) + (y >> 5)) % 2 ? 220 : 35;
    pixels[at] = v; pixels[at + 1] = (v + y) & 255; pixels[at + 2] = (v + x) & 255;
  }
  const image = deflateSync(pixels);
  const contents = Buffer.from("q 600 0 0 800 0 0 cm /Im0 Do Q\n");
  const bodies = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`), image, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from(`<< /Length ${contents.length} >>\nstream\n`), contents, Buffer.from("endstream")]),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let size = chunks[0]!.length;
  for (let i = 0; i < bodies.length; i++) {
    offsets.push(size);
    const object = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), bodies[i]!, Buffer.from("\nendobj\n")]);
    chunks.push(object); size += object.length;
  }
  const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
  chunks.push(Buffer.from(xref));
  return Buffer.concat(chunks);
}
const raster = scannedPdf();
const files = Array.from({ length: 16 }, (_, i) => join(root, `scan-${String(i).padStart(2, "0")}.pdf`));
for (const file of files) writeFileSync(file, raster);
await session("many-tabs-memory", files, async (cmd, pid) => {
  const snapshot = async (stage: string) => {
    const state = await cmd("TestUiState");
    const stats = await cmd("TestPerfStats");
    const rssKB = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim());
    const sample = { stage, rssKB, tabs: number(state, "tabs"), cacheKB: number(stats, "cacheKB"), cacheEntries: number(stats, "cacheEntries"), stats };
    report.memory.push(sample);
    console.log("MEMORY", JSON.stringify(sample));
    return sample;
  };
  await cmd("WaitRenderIdle", [15000]);
  check("16 scanned PDFs open in one window", number(await cmd("TestUiState"), "tabs") === 16, await cmd("TestUiState"));
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    seen.add((await cmd("TestCurrentTab")).split(" page=")[0]);
    const sample = await snapshot(`visit-${i}`);
    check(`Cache stays within 128 entries at tab ${i}`, sample.cacheEntries <= 128, sample.cacheEntries);
    await cmd("TestInvokeCommand", ["CmdNextTab"]);
    await cmd("WaitRenderIdle", [15000]);
  }
  check("All 16 tabs remain reachable", seen.size === 16, seen.size);
  await cmd("TestInvokeCommand", ["CmdCloseOtherTabs"]);
  await cmd("WaitRenderIdle", [15000]);
  const one = await snapshot("closed-other-tabs");
  check("Close Other Tabs leaves one document", one.tabs === 1, one);
  check("Closed documents release their render tiles", one.cacheEntries <= 4, one);
  await cmd("TestInvokeCommand", ["CmdClose"]);
  await delay(300);
  const empty = await snapshot("all-documents-closed");
  check("Closing the last document frees render cache", empty.cacheEntries === 0 && empty.cacheKB === 0, empty);
  for (let cycle = 0; cycle < 8; cycle++) {
    await cmd("TestInvokeCommand", ["CmdReopenLastClosedFile"]);
    await cmd("WaitRenderIdle", [15000]);
    await cmd("TestInvokeCommand", ["CmdClose"]);
    await delay(100);
    const sample = await snapshot(`reopen-close-${cycle}`);
    check(`Render cache clears after reopen/close ${cycle}`, sample.cacheEntries === 0, sample);
  }
});
writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
console.log(`Report: ${join(root, "report.json")}`);
if (report.checks.some((c) => !c.pass)) process.exitCode = 1;
