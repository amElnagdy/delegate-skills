using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class FakeCli {
  static int Main(string[] args) {
    // Mirrors the .cjs fake: any probe form, and hang/fail selected by the mode's suffix,
    // so a native-binary relay (agy, kimi, qoder, vibe, aider, oz, omp, kiro) enters the same preflight matrix.
    var mode = Environment.GetEnvironmentVariable("SMOKE_MODE") ?? "";
    var testContext = mode.Length > 0 ? mode : Environment.CurrentDirectory;
    if (Environment.GetEnvironmentVariable("KIRO_WSL_WRAPPER_TEST") == "1") {
      int execIndex = Array.IndexOf(args, "--exec");
      if (execIndex >= 0 && execIndex + 1 < args.Length) {
        var innerArgs = new string[args.Length - execIndex - 2];
        Array.Copy(args, execIndex + 2, innerArgs, 0, innerArgs.Length);
        args = innerArgs;
      }
    }
    if (args.Length > 1 && args[0] == "chat" && args[1] == "--help") {
      if (testContext.EndsWith("-version-hang") || testContext.EndsWith("-version-hang-tree")) Thread.Sleep(Timeout.Infinite);
      if (testContext.EndsWith("-version-fail") || testContext.EndsWith("-version-fail-silent")) return 7;
      Console.WriteLine(testContext.EndsWith("-help-missing")
        ? "--no-interactive --trust-tools --resume-id --effort --v3 --mode"
        : "--no-interactive --trust-tools --resume-id --wrap --effort --v3 --mode");
      return 0;
    }
    bool versionProbe = Array.IndexOf(args, "--version") >= 0
      || (args.Length > 0 && (args[0] == "version" || args[0] == "changelog"));
    if (versionProbe) {
      var versionPidFile = Environment.GetEnvironmentVariable("SMOKE_VERSION_PID_FILE");
      if (String.IsNullOrEmpty(versionPidFile) && Environment.CurrentDirectory.IndexOf("relay-smoke-", StringComparison.OrdinalIgnoreCase) >= 0) {
        versionPidFile = Path.Combine(Environment.CurrentDirectory, "smoke-version.pid");
      }
      if (!String.IsNullOrEmpty(versionPidFile)) File.WriteAllText(versionPidFile, Process.GetCurrentProcess().Id.ToString());
    }
    if (versionProbe && testContext.EndsWith("-version-hang-tree")) {
      var versionGrand = Process.Start(new ProcessStartInfo {
        FileName = Environment.GetEnvironmentVariable("SMOKE_NODE") ?? "node",
        Arguments = "-e setInterval(()=>{},1000)",
        UseShellExecute = false,
      });
      var versionGrandPidFile = Environment.GetEnvironmentVariable("SMOKE_VERSION_GRAND_PID_FILE");
      if (String.IsNullOrEmpty(versionGrandPidFile) && Environment.CurrentDirectory.IndexOf("relay-smoke-", StringComparison.OrdinalIgnoreCase) >= 0) {
        versionGrandPidFile = Path.Combine(Environment.CurrentDirectory, "smoke-version-grand.pid");
      }
      if (!String.IsNullOrEmpty(versionGrandPidFile)) File.WriteAllText(versionGrandPidFile, versionGrand.Id.ToString());
      Thread.Sleep(Timeout.Infinite);
      return 1;
    }
    if (versionProbe && testContext.EndsWith("-version-hang")) {
      Thread.Sleep(Timeout.Infinite);
      return 1;
    }
    if (versionProbe && testContext.EndsWith("-version-fail-silent")) {
      return 7;
    }
    if (versionProbe && testContext.EndsWith("-version-fail")) {
      Console.Error.WriteLine("fake version failure");
      return 7;
    }
    if (versionProbe) {
      Console.WriteLine("fake-cli 0.0.0-smoke");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "capture") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      return 0;
    }
    var writeFile = Environment.GetEnvironmentVariable("SMOKE_WRITE_FILE");
    if (!String.IsNullOrEmpty(writeFile)) File.WriteAllText(writeFile, "written by fake cli\n");
    if (mode == "aider-success") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      Console.WriteLine("Applied the edit and updated docs to explain OPENAI_API_KEY setup.");
      Console.WriteLine("If OPENAI_API_KEY is not set, the tool exits.");
      Console.WriteLine("Unable to connect without following the documented placeholder key steps.");
      return 0;
    }
    if (mode == "aider-auth-fail") {
      Console.WriteLine("litellm.AuthenticationError: Authentication Error, Invalid API key");
      return 0;
    }
    if (mode == "aider-exit-nonzero") {
      Console.Error.WriteLine("fake aider nonzero exit");
      return 7;
    }
    if (mode == "agy-permission-denied") {
      Console.Error.WriteLine("jetski: no output produced — a tool required the \"write_file\" permission that headless\nmode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow\nin settings.json (e.g. write_file(<target>)). Alternatively, re-run with\n--dangerously-skip-permissions to auto-approve all tools.");
      return 0;
    }
    if (mode == "agy-analysis") {
      var argsFile = Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE");
      if (!String.IsNullOrEmpty(argsFile)) File.WriteAllLines(argsFile, args);
      var logAt = Array.IndexOf(args, "--log-file");
      if (logAt >= 0) File.WriteAllText(args[logAt + 1], "fake agy log\n");
      Console.WriteLine("fake agy analysis completed");
      return 0;
    }
    if (mode == "agy-silent-edit") {
      File.AppendAllText(Environment.GetEnvironmentVariable("SMOKE_EDIT_FILE"), "dispatch edit\n");
      return 0;
    }
    if (mode == "agy-silent-noop") return 0;
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "qoder-success") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      Console.WriteLine("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"qoder-session-1\",\"model\":\"performance\",\"permissionMode\":\"auto\"}");
      Console.WriteLine("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"qoder-session-1\",\"result\":\"fake qoder completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":2}}");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("SMOKE_MODE") == "vibe-success") {
      File.WriteAllLines(Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE"), args);
      Console.WriteLine("{\"role\":\"assistant\",\"content\":\"working\"}");
      Console.WriteLine("{\"role\":\"assistant\",\"content\":\"fake vibe completed\"}");
      return 0;
    }
    if (mode == "omp-success" || mode == "omp-error") {
      var brief = Console.In.ReadToEnd() ?? "";
      var failed = mode == "omp-error";
      var argsFile = Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE");
      if (!String.IsNullOrEmpty(argsFile)) {
        var payload = new System.Text.StringBuilder();
        payload.Append("{\"args\":[");
        for (int i = 0; i < args.Length; i++) {
          if (i > 0) payload.Append(",");
          payload.Append(JsonString(args[i]));
        }
        payload.Append("],\"brief\":");
        payload.Append(JsonString(brief));
        payload.Append("}");
        File.WriteAllText(argsFile, payload.ToString());
      }
      Console.WriteLine("{\"type\":\"session\",\"version\":3,\"id\":\"omp-session-1\",\"timestamp\":\"2026-01-01T00:00:00.000Z\"}");
      Console.WriteLine("{\"type\":\"agent_start\"}");
      if (failed) {
        Console.WriteLine("{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"fake omp failed\"}],\"provider\":\"google\",\"model\":\"fake-model\",\"usage\":{\"input\":7,\"output\":2},\"stopReason\":\"error\",\"errorMessage\":\"fake provider failure\"}}");
      } else {
        Console.WriteLine("{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"fake omp completed\"}],\"provider\":\"google\",\"model\":\"fake-model\",\"usage\":{\"input\":7,\"output\":2},\"stopReason\":\"stop\"}}");
      }
      Console.WriteLine("{\"type\":\"agent_end\",\"messages\":[]}");
      return 0;
    }
    if (mode == "orphan-holds-stdio") {
      var logAt = Array.IndexOf(args, "--log-file");
      if (logAt >= 0) File.WriteAllText(args[logAt + 1], "fake agy log\n");
      Console.WriteLine("fake implementer completed");
      var outAt = Array.IndexOf(args, "-o");
      if (outAt >= 0) File.WriteAllText(args[outAt + 1].Trim('"'), "fake codex completed\n");
      var delayMs = 0;
      int.TryParse(Environment.GetEnvironmentVariable("SMOKE_ORPHAN_EXIT_DELAY_MS") ?? "0", out delayMs);
      var orphanPsi = new ProcessStartInfo {
        FileName = Environment.GetEnvironmentVariable("SMOKE_NODE") ?? "node",
        Arguments = "-e setTimeout(()=>{},60000)",
        UseShellExecute = false,
      };
      var orphan = Process.Start(orphanPsi);
      var orphanPidFile = Environment.GetEnvironmentVariable("SMOKE_GRAND_PID_FILE");
      if (!String.IsNullOrEmpty(orphanPidFile) && orphan != null) File.WriteAllText(orphanPidFile, orphan.Id.ToString());
      if (delayMs > 0) Thread.Sleep(delayMs);
      return 0;
    }
    if (Environment.GetEnvironmentVariable("KIRO_FAKE_MODE") == "large-stdout") {
      Console.Write("START\n" + new String('x', 70000) + "\nSession: 11111111-1111-4111-8111-111111111111\n");
      return 0;
    }
    if (Environment.GetEnvironmentVariable("KIRO_FAKE_MODE") == "split") {
      Console.WriteLine("fake kiro completed");
      Console.Error.Write("partial-api-");
      Console.Error.Flush();
      Thread.Sleep(200);
      Console.Error.Write("secret-value\n");
      Console.Error.Flush();
      return 0;
    }
    if (Array.IndexOf(args, "--resume-id") >= 0) {
      var argsFile = Environment.GetEnvironmentVariable("SMOKE_ARGS_FILE") ?? Path.Combine(Environment.CurrentDirectory, "smoke-args.json");
      File.WriteAllLines(argsFile, args);
      Console.WriteLine("fake kiro completed");
      Console.WriteLine("Session: 11111111-1111-4111-8111-111111111111");
      return 0;
    }
    var psi = new ProcessStartInfo {
      // Kiro scrubs SMOKE_* from the implementer environment, so the node
      // launcher must fall back to PATH lookup when SMOKE_NODE is absent.
      FileName = Environment.GetEnvironmentVariable("SMOKE_NODE") ?? "node",
      Arguments = "-e setInterval(()=>{},1000)",
      UseShellExecute = false,
    };
    var grand = Process.Start(psi);
    // Kiro scrubs SMOKE_* from the implementer environment, so kiro's own tests
    // point these files inside the committed worktree and the fake re-derives the
    // same paths from its cwd when the variables are absent. Every other relay
    // forwards the environment, so an explicit path always wins when present.
    var grandPidPath = Environment.GetEnvironmentVariable("SMOKE_GRAND_PID_FILE")
      ?? Path.Combine(Environment.CurrentDirectory, "smoke-grand.pid");
    var pidPath = Environment.GetEnvironmentVariable("SMOKE_PID_FILE")
      ?? Path.Combine(Environment.CurrentDirectory, "smoke.pid");
    File.WriteAllText(grandPidPath, grand.Id.ToString());
    File.WriteAllText(pidPath, Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }
  static string JsonString(string s) {
    if (s == null) s = "";
    return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n") + "\"";
  }
}
