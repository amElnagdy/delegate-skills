using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class FakeCli {
  static int Main(string[] args) {
    // Mirrors the .cjs fake: any probe form, and hang/fail selected by the mode's suffix,
    // so a native-binary relay (agy, kimi, qoder, vibe) enters the same preflight matrix.
    var mode = Environment.GetEnvironmentVariable("SMOKE_MODE") ?? "";
    bool versionProbe = Array.IndexOf(args, "--version") >= 0
      || (args.Length > 0 && (args[0] == "version" || args[0] == "changelog"));
    if (versionProbe && mode.EndsWith("-version-hang")) {
      Thread.Sleep(Timeout.Infinite);
      return 1;
    }
    if (versionProbe && mode.EndsWith("-version-fail-silent")) {
      return 7;
    }
    if (versionProbe && mode.EndsWith("-version-fail")) {
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
    var psi = new ProcessStartInfo {
      FileName = Environment.GetEnvironmentVariable("SMOKE_NODE"),
      Arguments = "-e setInterval(()=>{},1000)",
      UseShellExecute = false,
    };
    var grand = Process.Start(psi);
    File.WriteAllText(Environment.GetEnvironmentVariable("SMOKE_GRAND_PID_FILE"), grand.Id.ToString());
    File.WriteAllText(Environment.GetEnvironmentVariable("SMOKE_PID_FILE"), Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }
}
