// Detached-launch planning for `mantle start` — pure, so both platform
// branches stay unit-testable without spawning anything.
//
// Windows: a .cmd launcher opened in its own console window via
// `cmd /c start` (the visible console IS the log surface). The server
// writes its own PID file, so the launcher pid is never captured.
//
// POSIX: `sh -c 'exec nohup ... >> .mantle/mantle.log 2>&1'` — `exec`
// makes the spawned sh BECOME the server (its pid is the server until
// index.ts stamps the PID file itself), `nohup` survives the terminal
// closing after the CLI returns, and the log file replaces the console
// window as the log surface.

export interface LaunchPlan {
  // argv for Bun.spawn; the spawned process must be unref()'d by the caller.
  argv: string[];
  // Windows only: write this launcher file before spawning (argv references it).
  launcherFile?: { path: string; content: string };
  // Where logs land, when not a visible console. Shown to the user.
  logPath?: string;
}

export function planLaunch(opts: {
  platform: NodeJS.Platform;
  bunPath: string;
  entryScript: string;
  mantleDir: string; // absolute path to .mantle/
}): LaunchPlan {
  const { platform, bunPath, entryScript, mantleDir } = opts;

  if (platform === "win32") {
    const launcherPath = `${mantleDir}\\launcher.cmd`;
    const content = [
      `@echo off`,
      `title rev://MANTLE`,
      `"${bunPath}" run "${entryScript}"`,
      `exit`,
    ].join("\r\n");
    return {
      argv: ["cmd", "/c", "start", "", launcherPath],
      launcherFile: { path: launcherPath, content },
    };
  }

  const logPath = `${mantleDir}/mantle.log`;
  // Single-quote for sh, escaping any embedded single quotes ('\'') — paths
  // with spaces are the common case, quotes the pathological one.
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
  return {
    argv: [
      "sh",
      "-c",
      `exec nohup ${q(bunPath)} run ${q(entryScript)} >> ${q(logPath)} 2>&1 < /dev/null`,
    ],
    logPath,
  };
}
