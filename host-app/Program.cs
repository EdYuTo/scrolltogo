// scrolltogo host app: opens the host page in its own Chrome window and keeps
// that window's processes at the GPU scheduling priority OBS gives itself
// (libobs-d3d11/d3d11-subsystem.cpp), so an uncapped game can't starve screen
// capture and encoding. Setting another process's GPU scheduling class works
// without admin rights, so everything runs as the normal user.
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32;

static class Program
{
    const string Url = "https://scrolltogo.edson-yudi-toma.workers.dev/";

    static int Main()
    {
        var browser = FindBrowser();
        if (browser == null)
        {
            Native.MessageBox(IntPtr.Zero, "scrolltogo needs Google Chrome or Microsoft Edge installed.", "scrolltogo", 0x10);
            return 1;
        }

        // A separate profile keeps this window (and its boosted processes) apart from normal browsing.
        var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "scrolltogo", "browser-profile");
        var start = new ProcessStartInfo(browser) { UseShellExecute = false };
        foreach (var arg in new[] { $"--app={Url}", $"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--window-size=960,1000" })
            start.ArgumentList.Add(arg);
        using var window = Process.Start(start)!;

        // Runs invisibly until the window is closed.
        Booster.Run(window.Id);
        return 0;
    }

    static string? FindBrowser()
    {
        foreach (var exe in new[] { "chrome.exe", "msedge.exe" })
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            using var key = hive.OpenSubKey($@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}");
            if (key?.GetValue(null) is string path && File.Exists(path.Trim('"'))) return path.Trim('"');
        }
        return null;
    }
}

static class Booster
{
    // Follows the browser's process tree (Chrome restarts its GPU process at
    // times) and applies the priority to every process in it until all exit.
    public static void Run(int root)
    {
        // Same rule as OBS: REALTIME normally, HIGH when hardware-accelerated GPU scheduling is on.
        var hags = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\GraphicsDrivers", "HwSchMode", 0) is int mode && mode == 2;
        var priority = hags ? Native.PriorityHigh : Native.PriorityRealtime;

        var tree = new HashSet<int> { root };
        var boosted = new HashSet<int>();
        var lastFullPass = DateTime.MinValue;

        while (true)
        {
            var parents = Native.ProcessParents();
            tree.RemoveWhere(pid => !parents.ContainsKey(pid));

            bool grew;
            do
            {
                grew = false;
                foreach (var (pid, parent) in parents)
                    if (tree.Contains(parent) && tree.Add(pid)) grew = true;
            } while (grew);

            if (tree.Count == 0) return;

            // Re-apply now and then in case something resets it.
            var fullPass = DateTime.UtcNow - lastFullPass > TimeSpan.FromSeconds(15);
            if (fullPass) lastFullPass = DateTime.UtcNow;
            foreach (var pid in tree)
                if ((fullPass || !boosted.Contains(pid)) && Native.SetGpuPriority(pid, priority))
                    boosted.Add(pid);
            boosted.IntersectWith(tree);

            Thread.Sleep(1000);
        }
    }
}

static class Native
{
    public const int PriorityHigh = 4;
    public const int PriorityRealtime = 5;

    const uint ProcessSetInformation = 0x0200;
    const uint ProcessQueryInformation = 0x0400;
    const uint SnapProcess = 0x2;

    [DllImport("gdi32.dll")]
    static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priority);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int MessageBox(IntPtr owner, string text, string caption, uint type);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint Size, Usage, ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId, Threads, ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }

    public static bool SetGpuPriority(int pid, int priority)
    {
        var handle = OpenProcess(ProcessSetInformation | ProcessQueryInformation, false, pid);
        if (handle == IntPtr.Zero) return false;
        try { return D3DKMTSetProcessSchedulingPriorityClass(handle, priority) == 0; }
        finally { CloseHandle(handle); }
    }

    // pid -> parent pid for every running process.
    public static Dictionary<int, int> ProcessParents()
    {
        var result = new Dictionary<int, int>();
        var snapshot = CreateToolhelp32Snapshot(SnapProcess, 0);
        if (snapshot == new IntPtr(-1)) return result;
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            for (var ok = Process32FirstW(snapshot, ref entry); ok; ok = Process32NextW(snapshot, ref entry))
                result[(int)entry.ProcessId] = (int)entry.ParentProcessId;
        }
        finally { CloseHandle(snapshot); }
        return result;
    }
}
