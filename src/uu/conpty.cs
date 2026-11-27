using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace UuConpty {
  internal static class Native {
    public const int STD_INPUT_HANDLE = -10;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);
    public const uint INFINITE = 0xFFFFFFFF;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD {
      public short X;
      public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES {
      public int nLength;
      public IntPtr lpSecurityDescriptor;
      public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
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
    public struct STARTUPINFOEX {
      public STARTUPINFO StartupInfo;
      public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public int dwProcessId;
      public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(
      out SafeFileHandle hReadPipe,
      out SafeFileHandle hWritePipe,
      ref SECURITY_ATTRIBUTES lpPipeAttributes,
      int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int CreatePseudoConsole(
      COORD size,
      SafeFileHandle hInput,
      SafeFileHandle hOutput,
      uint dwFlags,
      out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int ResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(
      IntPtr lpAttributeList,
      int dwAttributeCount,
      int dwFlags,
      ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(
      IntPtr lpAttributeList,
      uint dwFlags,
      IntPtr Attribute,
      IntPtr lpValue,
      IntPtr cbSize,
      IntPtr lpPreviousValue,
      IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
      string lpApplicationName,
      StringBuilder lpCommandLine,
      IntPtr lpProcessAttributes,
      IntPtr lpThreadAttributes,
      bool bInheritHandles,
      uint dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFOEX lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(
      IntPtr hJob,
      int JobObjectInfoClass,
      ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo,
      int cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  }

  internal static class Program {
    private static readonly object OutLock = new object();
    private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);
    private static Stream _stdout;
    private static IntPtr _hPC = IntPtr.Zero;
    private static IntPtr _hProcess = IntPtr.Zero;
    private static IntPtr _hJob = IntPtr.Zero;
    private static FileStream _ptyIn;
    private static FileStream _ptyOut;
    private static int _closing = 0;
    private static int _exitEmitted = 0;
    private static readonly ManualResetEventSlim ReaderDone = new ManualResetEventSlim(false);

    private static void EmitJson(string json) {
      byte[] bytes = Utf8NoBom.GetBytes(json + "\n");
      lock (OutLock) {
        try {
          _stdout.Write(bytes, 0, bytes.Length);
          _stdout.Flush();
        } catch { }
      }
    }

    private static void EmitExit(int code) {
      if (Interlocked.Exchange(ref _exitEmitted, 1) == 0) {
        EmitJson("{\"type\":\"exit\",\"code\":" + code + "}");
      }
    }

    private static string QuoteArg(string arg) {
      if (arg.Length == 0) return "\"\"";
      bool needsQuotes = false;
      for (int i = 0; i < arg.Length; i++) {
        char c = arg[i];
        if (c == ' ' || c == '\t' || c == '"' || c == '\n' || c == '\v') {
          needsQuotes = true;
          break;
        }
      }
      if (!needsQuotes) return arg;
      StringBuilder sb = new StringBuilder();
      sb.Append('"');
      int backslashes = 0;
      for (int i = 0; i < arg.Length; i++) {
        char c = arg[i];
        if (c == '\\') {
          backslashes++;
        } else if (c == '"') {
          sb.Append('\\', backslashes * 2 + 1);
          sb.Append('"');
          backslashes = 0;
        } else {
          if (backslashes > 0) {
            sb.Append('\\', backslashes);
            backslashes = 0;
          }
          sb.Append(c);
        }
      }
      if (backslashes > 0) {
        sb.Append('\\', backslashes * 2);
      }
      sb.Append('"');
      return sb.ToString();
    }

    private static string ExtractJsonString(string json, string key) {
      string token = "\"" + key + "\"";
      int idx = json.IndexOf(token, StringComparison.Ordinal);
      if (idx < 0) return null;
      int colon = json.IndexOf(':', idx + token.Length);
      if (colon < 0) return null;
      int q1 = json.IndexOf('"', colon + 1);
      if (q1 < 0) return null;
      StringBuilder sb = new StringBuilder();
      for (int i = q1 + 1; i < json.Length; i++) {
        char c = json[i];
        if (c == '\\' && i + 1 < json.Length) {
          char n = json[++i];
          if (n == '"' || n == '\\' || n == '/') sb.Append(n);
          else if (n == 'n') sb.Append('\n');
          else if (n == 'r') sb.Append('\r');
          else if (n == 't') sb.Append('\t');
          else sb.Append(n);
        } else if (c == '"') {
          return sb.ToString();
        } else {
          sb.Append(c);
        }
      }
      return null;
    }

    private static int ExtractJsonInt(string json, string key, int fallback) {
      string token = "\"" + key + "\"";
      int idx = json.IndexOf(token, StringComparison.Ordinal);
      if (idx < 0) return fallback;
      int colon = json.IndexOf(':', idx + token.Length);
      if (colon < 0) return fallback;
      int pos = colon + 1;
      while (pos < json.Length && (json[pos] == ' ' || json[pos] == '\t')) pos++;
      int start = pos;
      if (pos < json.Length && json[pos] == '-') pos++;
      while (pos < json.Length && json[pos] >= '0' && json[pos] <= '9') pos++;
      int val;
      if (pos > start && int.TryParse(json.Substring(start, pos - start), out val)) {
        return val;
      }
      return fallback;
    }

    private static void ClosePseudoConsoleBounded() {
      IntPtr hPC = Interlocked.Exchange(ref _hPC, IntPtr.Zero);
      if (hPC == IntPtr.Zero) return;
      ManualResetEventSlim done = new ManualResetEventSlim(false);
      Thread t = new Thread(() => {
        try { Native.ClosePseudoConsole(hPC); } catch { }
        done.Set();
      });
      t.IsBackground = true;
      t.Start();
      done.Wait(1500);
    }

    private static void Shutdown(bool killChild) {
      if (Interlocked.Exchange(ref _closing, 1) != 0) return;
      if (killChild) {
        if (_hProcess != IntPtr.Zero) {
          try { Native.TerminateProcess(_hProcess, 1); } catch { }
        }
        if (_hJob != IntPtr.Zero) {
          try { Native.CloseHandle(_hJob); } catch { }
          _hJob = IntPtr.Zero;
        }
      }
      try { if (_ptyIn != null) _ptyIn.Close(); } catch { }
      ClosePseudoConsoleBounded();
      ReaderDone.Wait(500);
      try { if (_ptyOut != null) _ptyOut.Close(); } catch { }
      int exitCode = 1;
      if (_hProcess != IntPtr.Zero) {
        uint ec;
        if (Native.GetExitCodeProcess(_hProcess, out ec) && ec != 259) {
          exitCode = unchecked((int)ec);
        }
        try { Native.CloseHandle(_hProcess); } catch { }
        _hProcess = IntPtr.Zero;
      }
      EmitExit(exitCode);
    }

    public static int Main(string[] args) {
      if (args.Length < 3) {
        Console.Error.WriteLine("Usage: uu-conpty <cols> <rows> <exePath> [childArgs...]");
        return 2;
      }

      short cols = 160;
      short rows = 40;
      short.TryParse(args[0], out cols);
      short.TryParse(args[1], out rows);
      if (cols < 20) cols = 20;
      if (rows < 5) rows = 5;

      string exePath = args[2];
      StringBuilder cmdLine = new StringBuilder();
      cmdLine.Append(QuoteArg(exePath));
      for (int i = 3; i < args.Length; i++) {
        cmdLine.Append(' ');
        cmdLine.Append(QuoteArg(args[i]));
      }

      _stdout = Console.OpenStandardOutput();

      Native.SECURITY_ATTRIBUTES sa = new Native.SECURITY_ATTRIBUTES();
      sa.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
      sa.bInheritHandle = 0;

      SafeFileHandle ptyInRead, ptyInWrite, ptyOutRead, ptyOutWrite;
      if (!Native.CreatePipe(out ptyInRead, out ptyInWrite, ref sa, 0) ||
          !Native.CreatePipe(out ptyOutRead, out ptyOutWrite, ref sa, 0)) {
        Console.Error.WriteLine("CreatePipe failed: " + Marshal.GetLastWin32Error());
        return 1;
      }

      Native.COORD size = new Native.COORD { X = cols, Y = rows };
      int hr = Native.CreatePseudoConsole(size, ptyInRead, ptyOutWrite, 0, out _hPC);
      // Close child ends in parent immediately so pipe EOF works cleanly
      ptyInRead.Close();
      ptyOutWrite.Close();

      if (hr != 0 || _hPC == IntPtr.Zero) {
        ptyInWrite.Close();
        ptyOutRead.Close();
        Console.Error.WriteLine("CreatePseudoConsole failed: 0x" + hr.ToString("X"));
        return 1;
      }

      IntPtr attrSize = IntPtr.Zero;
      Native.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
      IntPtr attrList = Marshal.AllocHGlobal(attrSize);

      Native.STARTUPINFOEX siEx = new Native.STARTUPINFOEX();
      siEx.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
      siEx.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES: prevent inheriting parent's redirected pipes so child binds to ConPTY
      siEx.StartupInfo.hStdInput = IntPtr.Zero;
      siEx.StartupInfo.hStdOutput = IntPtr.Zero;
      siEx.StartupInfo.hStdError = IntPtr.Zero;
      siEx.lpAttributeList = attrList;

      Native.PROCESS_INFORMATION pi;
      bool started = false;
      try {
        if (!Native.InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) {
          Console.Error.WriteLine("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
          return 1;
        }
        if (!Native.UpdateProcThreadAttribute(
              attrList,
              0,
              Native.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
              _hPC,
              new IntPtr(IntPtr.Size),
              IntPtr.Zero,
              IntPtr.Zero)) {
          Console.Error.WriteLine("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
          return 1;
        }

        started = Native.CreateProcessW(
          exePath,
          cmdLine,
          IntPtr.Zero,
          IntPtr.Zero,
          false,
          Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_UNICODE_ENVIRONMENT,
          IntPtr.Zero,
          null,
          ref siEx,
          out pi);

        if (!started) {
          int err = Marshal.GetLastWin32Error();
          Console.Error.WriteLine("CreateProcessW failed: " + err);
          ClosePseudoConsoleBounded();
          ptyInWrite.Close();
          ptyOutRead.Close();
          return 1;
        }
      } finally {
        Native.DeleteProcThreadAttributeList(attrList);
        Marshal.FreeHGlobal(attrList);
      }

      _hProcess = pi.hProcess;
      try { Native.CloseHandle(pi.hThread); } catch { }

      try {
        IntPtr job = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero) {
          var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
          info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
          if (Native.SetInformationJobObject(
                job,
                Native.JobObjectExtendedLimitInformation,
                ref info,
                Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION))) &&
              Native.AssignProcessToJobObject(job, _hProcess)) {
            _hJob = job;
          } else {
            Native.CloseHandle(job);
          }
        }
      } catch { }

      _ptyIn = new FileStream(ptyInWrite, FileAccess.Write, 4096, false);
      _ptyOut = new FileStream(ptyOutRead, FileAccess.Read, 4096, false);

      EmitJson("{\"type\":\"ready\",\"pid\":" + pi.dwProcessId + "}");

      Thread reader = new Thread(() => {
        byte[] buf = new byte[8192];
        try {
          while (true) {
            int n = _ptyOut.Read(buf, 0, buf.Length);
            if (n <= 0) break;
            string b64 = Convert.ToBase64String(buf, 0, n);
            EmitJson("{\"type\":\"data\",\"b64\":\"" + b64 + "\"}");
          }
        } catch { }
        ReaderDone.Set();
      });
      reader.IsBackground = true;
      reader.Start();

      Thread stdinThread = new Thread(() => {
        try {
          using (var sr = new StreamReader(Console.OpenStandardInput(), Utf8NoBom)) {
            string line;
            while ((line = sr.ReadLine()) != null) {
              line = line.Trim();
              if (line.Length == 0) continue;
              string type = ExtractJsonString(line, "type");
              if (type == "write") {
                string b64 = ExtractJsonString(line, "b64");
                if (!string.IsNullOrEmpty(b64)) {
                  byte[] bytes = Convert.FromBase64String(b64);
                  lock (_ptyIn) {
                    _ptyIn.Write(bytes, 0, bytes.Length);
                    _ptyIn.Flush();
                  }
                }
              } else if (type == "resize") {
                int c = ExtractJsonInt(line, "cols", cols);
                int r = ExtractJsonInt(line, "rows", rows);
                if (c < 20) c = 20;
                if (r < 5) r = 5;
                IntPtr h = _hPC;
                if (h != IntPtr.Zero) {
                  Native.ResizePseudoConsole(h, new Native.COORD { X = (short)c, Y = (short)r });
                }
              } else if (type == "close") {
                Shutdown(true);
                Environment.Exit(0);
              }
            }
          }
        } catch { }
        // Stdin EOF -> parent died
        Shutdown(true);
        Environment.Exit(0);
      });
      stdinThread.IsBackground = true;
      stdinThread.Start();

      Native.WaitForSingleObject(_hProcess, Native.INFINITE);
      uint ec = 0;
      Native.GetExitCodeProcess(_hProcess, out ec);
      // Close pseudo console so ptyOut reaches EOF and drains remaining output
      ClosePseudoConsoleBounded();
      ReaderDone.Wait(800);
      Shutdown(false);
      EmitExit(unchecked((int)ec));
      return 0;
    }
  }
}
