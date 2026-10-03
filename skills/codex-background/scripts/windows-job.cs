// Kernel job ownership survives relay-parent exit. No PID discovery or adoption.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class DelegateJobOwner {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string reserved, desktop, title; public uint x, y, xSize, ySize, xCount, yCount, fill, flags; public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint processId, threadId; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref EXTENDED_LIMIT limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int info, out ACCOUNTING counts, uint size, IntPtr length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  static void Require(bool okay) { if (!okay) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var text = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); text.Append(c); slashes = 0;
    }
    text.Append('\\', slashes * 2); return text.Append('"').ToString();
  }
  public static int Run(string node, string[] args, string cwd, string exitPath) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null); Require(job != IntPtr.Zero);
    PROCESS_INFORMATION process = new PROCESS_INFORMATION(); bool assigned = false;
    try {
      var limits = new EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway.
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT))));
      var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)); startup.flags = 0x100;
      startup.stdin = GetStdHandle(-10); startup.stdout = GetStdHandle(-11); startup.stderr = GetStdHandle(-12);
      var command = new StringBuilder(Quote(node)); foreach (string arg in args) command.Append(" ").Append(Quote(arg));
      Require(CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, true, 4 | 0x08000000, IntPtr.Zero, cwd, ref startup, out process));
      Require(AssignProcessToJobObject(job, process.process)); assigned = true;
      Require(ResumeThread(process.thread) != UInt32.MaxValue);
      uint code = 1; bool rootExited = false;
      for (;;) {
        uint waited = WaitForSingleObject(process.process, 100);
        if (waited == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!rootExited && waited == 0) {
          Require(GetExitCodeProcess(process.process, out code)); rootExited = true;
          File.WriteAllText(exitPath + ".tmp", "{\"exitCode\":" + code + ",\"signal\":null}");
          File.Move(exitPath + ".tmp", exitPath);
        }
        ACCOUNTING counts; Require(QueryInformationJobObject(job, 1, out counts, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero));
        if (rootExited && counts.ActiveProcesses == 0) return unchecked((int)code);
        if (rootExited) Thread.Sleep(100);
      }
    } finally {
      if (!assigned && process.process != IntPtr.Zero) TerminateProcess(process.process, 1);
      if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
      if (process.process != IntPtr.Zero) CloseHandle(process.process);
      CloseHandle(job); // Kills members even if their original parent has already exited.
    }
  }
}
