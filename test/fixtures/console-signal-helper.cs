using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class ConsoleSignalHelper {
  private const uint CREATE_NEW_CONSOLE = 0x00000010;
  private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  private const uint CTRL_C_EVENT = 0;
  private const uint INFINITE = 0xffffffff;
  private const uint WAIT_OBJECT_0 = 0;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  private static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    string currentDirectory,
    ref STARTUPINFO startupInfo,
    out PROCESS_INFORMATION processInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool FreeConsole();

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AttachConsole(uint processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GenerateConsoleCtrlEvent(uint eventType, uint processGroupId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetConsoleCtrlHandler(IntPtr handlerRoutine, bool add);

  private static string Quote(string value) {
    return "\"" + value.Replace("\"", "\\\"") + "\"";
  }

  private static void Fail(string message, PROCESS_INFORMATION process) {
    Console.Error.WriteLine("console-signal-helper: " + message + " (error " + Marshal.GetLastWin32Error() + ")");
    if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
    Environment.Exit(1);
  }

  public static int Main(string[] args) {
    if (args.Length < 7) {
      Console.Error.WriteLine("usage: helper <node> <relay> <brief> <workdir> <outdir> <kiro-bin> <ready-file>");
      return 2;
    }

    var node = args[0];
    var relay = args[1];
    var brief = args[2];
    var workdir = args[3];
    var outdir = args[4];
    var kiroBin = args[5];
    var readyFile = args[6];
    var commandLine = new StringBuilder(Quote(node) + " " + Quote(relay)
      + " --brief " + Quote(brief)
      + " --cd " + Quote(workdir)
      + " --out-dir " + Quote(outdir)
      + " --kiro-bin " + Quote(kiroBin));
    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(startup);
    var process = new PROCESS_INFORMATION();
    var created = CreateProcess(node, commandLine, IntPtr.Zero, IntPtr.Zero, false,
      CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, workdir,
      ref startup, out process);
    if (!created) Fail("CreateProcess failed", process);

    var ready = false;
    for (var i = 0; i < 150; i++) {
      if (File.Exists(readyFile)) { ready = true; break; }
      Thread.Sleep(100);
    }
    if (!ready) Fail("relay did not reach the fake implementer", process);
    Thread.Sleep(300);

    // Ignore the control event in this helper, then attach to the relay's new console.
    SetConsoleCtrlHandler(IntPtr.Zero, true);
    FreeConsole();
    var attached = false;
    for (var i = 0; i < 20 && !attached; i++) {
      attached = AttachConsole(process.dwProcessId);
      if (!attached) Thread.Sleep(100);
    }
    if (!attached) Fail("AttachConsole failed", process);
    if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)) Fail("GenerateConsoleCtrlEvent failed", process);
    Thread.Sleep(300);
    FreeConsole();

    if (WaitForSingleObject(process.hProcess, 30000) != WAIT_OBJECT_0) Fail("relay did not exit", process);
    uint exitCode;
    if (!GetExitCodeProcess(process.hProcess, out exitCode)) Fail("GetExitCodeProcess failed", process);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return unchecked((int)exitCode);
  }
}
