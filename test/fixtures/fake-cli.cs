using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class FakeCli {
  static int Main(string[] args) {
    // Mirrors the .cjs fake: any probe form, and hang/fail selected by the mode's suffix,
    // so a native-binary relay (agy, kimi, qoder, vibe) enters the same preflight matrix.
    var mode = Environment.GetEnvironmentVariable("SMOKE_MODE") ?? "";
    var testContext = mode.Length > 0 ? mode : Environment.CurrentDirectory;
    if (args.Length > 1 && args[0] == "chat" && args[1] == "--help") {
      if (testContext.EndsWith("-version-fail") || testContext.EndsWith("-version-fail-silent")) return 7;
      Console.WriteLine(testContext.EndsWith("-help-missing")
        ? "--no-interactive --trust-tools --resume-id"
        : "--no-interactive --trust-tools --resume-id --wrap");
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
      FileName = Environment.GetEnvironmentVariable("SMOKE_NODE") ?? "node",
      Arguments = "-e setInterval(()=>{},1000)",
      UseShellExecute = false,
    };
    var grand = Process.Start(psi);
    var grandPidFile = Environment.GetEnvironmentVariable("SMOKE_GRAND_PID_FILE") ?? Path.Combine(Environment.CurrentDirectory, "smoke-grand.pid");
    var pidFile = Environment.GetEnvironmentVariable("SMOKE_PID_FILE") ?? Path.Combine(Environment.CurrentDirectory, "smoke.pid");
    File.WriteAllText(grandPidFile, grand.Id.ToString());
    File.WriteAllText(pidFile, Process.GetCurrentProcess().Id.ToString());
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }
}
