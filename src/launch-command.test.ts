import { describe, expect, test } from "bun:test";
import { planLaunch } from "./launch-command.js";

describe("planLaunch", () => {
  const base = {
    bunPath: "/usr/local/bin/bun",
    entryScript: "/home/user/rev-mantle/src/index.ts",
    mantleDir: "/home/user/rev-mantle/.mantle",
  };

  test("win32: cmd-start launcher in its own console window", () => {
    const plan = planLaunch({
      ...base,
      platform: "win32",
      bunPath: "C:\\bun\\bun.exe",
      entryScript: "C:\\repo\\src\\index.ts",
      mantleDir: "C:\\repo\\.mantle",
    });
    expect(plan.argv).toEqual(["cmd", "/c", "start", "", "C:\\repo\\.mantle\\launcher.cmd"]);
    expect(plan.launcherFile?.path).toBe("C:\\repo\\.mantle\\launcher.cmd");
    expect(plan.launcherFile?.content).toContain(`"C:\\bun\\bun.exe" run "C:\\repo\\src\\index.ts"`);
    expect(plan.launcherFile?.content).toContain("title rev://MANTLE");
    expect(plan.logPath).toBeUndefined();
  });

  test("posix: sh -c with exec + nohup, logs appended to .mantle/mantle.log", () => {
    const plan = planLaunch({ ...base, platform: "linux" });
    expect(plan.argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = plan.argv[2]!;
    expect(script.startsWith("exec nohup ")).toBe(true);
    expect(script).toContain("'/usr/local/bin/bun' run '/home/user/rev-mantle/src/index.ts'");
    expect(script).toContain(">> '/home/user/rev-mantle/.mantle/mantle.log' 2>&1 < /dev/null");
    expect(plan.launcherFile).toBeUndefined();
    expect(plan.logPath).toBe("/home/user/rev-mantle/.mantle/mantle.log");
  });

  test("posix: paths with spaces and single quotes stay one sh word", () => {
    const plan = planLaunch({
      ...base,
      platform: "darwin",
      entryScript: "/Users/o'brien/my repo/src/index.ts",
    });
    const script = plan.argv[2]!;
    // sh-quoting: embedded single quote becomes '\'' inside the quoted word.
    expect(script).toContain(`'/Users/o'\\''brien/my repo/src/index.ts'`);
  });
});
