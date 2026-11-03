$ErrorActionPreference = "Stop"

$sourceDirectory = $PSScriptRoot
$desktopDirectory = [Environment]::GetFolderPath("Desktop")
$applicationDirectory = Join-Path $desktopDirectory "Traumatic Studios"
$runtimeDirectory = Join-Path $applicationDirectory "runtime"
$projectDirectory = Join-Path $applicationDirectory "projects"
$publicDirectory = Join-Path $applicationDirectory "public"

New-Item -ItemType Directory -Path $applicationDirectory, $runtimeDirectory, $projectDirectory, $publicDirectory -Force | Out-Null

foreach ($fileName in @("server.js", "studio.js", "demo-studio.js", "local-studio.js", "settings.js", "memory-store.js", "project-builder.js", "package.json")) {
  Copy-Item -LiteralPath (Join-Path $sourceDirectory $fileName) -Destination (Join-Path $applicationDirectory $fileName) -Force
}

Copy-Item -Path (Join-Path $sourceDirectory "public\*") -Destination $publicDirectory -Recurse -Force

$logoPath = Join-Path $publicDirectory "traumatic-studios-logo.png"
$iconPath = Join-Path $applicationDirectory "Traumatic Studios.ico"
Add-Type -AssemblyName System.Drawing
$iconBitmap = $null
$graphics = $null
$pngStream = $null
$iconStream = $null
$iconWriter = $null
$logo = [System.Drawing.Bitmap]::FromFile($logoPath)
try {
  $iconSize = 256
  $cropSize = [int][Math]::Min($logo.Width, [Math]::Floor($logo.Height * 0.72))
  $cropLeft = [int][Math]::Floor(($logo.Width - $cropSize) / 2)
  $crop = New-Object System.Drawing.Rectangle($cropLeft, 0, $cropSize, $cropSize)
  $iconBitmap = New-Object System.Drawing.Bitmap($iconSize, $iconSize)
  $graphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.DrawImage($logo, [System.Drawing.Rectangle]::new(0, 0, $iconSize, $iconSize), $crop, [System.Drawing.GraphicsUnit]::Pixel)

  $pngStream = New-Object System.IO.MemoryStream
  $iconBitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngBytes = $pngStream.ToArray()
  $iconStream = [System.IO.File]::Create($iconPath)
  $iconWriter = New-Object System.IO.BinaryWriter($iconStream)
  $iconWriter.Write([UInt16]0)
  $iconWriter.Write([UInt16]1)
  $iconWriter.Write([UInt16]1)
  $iconWriter.Write([Byte]0)
  $iconWriter.Write([Byte]0)
  $iconWriter.Write([Byte]0)
  $iconWriter.Write([Byte]0)
  $iconWriter.Write([UInt16]1)
  $iconWriter.Write([UInt16]32)
  $iconWriter.Write([UInt32]$pngBytes.Length)
  $iconWriter.Write([UInt32]22)
  $iconWriter.Write($pngBytes)
} finally {
  if ($iconWriter) {
    $iconWriter.Dispose()
  } elseif ($iconStream) {
    $iconStream.Dispose()
  }
  if ($pngStream) { $pngStream.Dispose() }
  if ($graphics) { $graphics.Dispose() }
  if ($iconBitmap) { $iconBitmap.Dispose() }
  $logo.Dispose()
}

$nodePath = (& node -p "process.execPath").Trim()
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Could not find the active Node.js runtime at $nodePath."
}
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $runtimeDirectory "node.exe") -Force

$sourceProjects = Join-Path $sourceDirectory "projects"
if (Test-Path -LiteralPath $sourceProjects -PathType Container) {
  Get-ChildItem -LiteralPath $sourceProjects -Directory |
    Where-Object { $_.Name -match '^game-\d+-[a-f0-9]{8}$' } |
    ForEach-Object {
      $destinationProject = Join-Path $projectDirectory $_.Name
      New-Item -ItemType Directory -Path $destinationProject -Force | Out-Null
      Copy-Item -Path (Join-Path $_.FullName "*") -Destination $destinationProject -Recurse -Force
    }
}

$sourceMemory = Join-Path $sourceDirectory "data"
if (Test-Path -LiteralPath $sourceMemory -PathType Container) {
  Copy-Item -LiteralPath $sourceMemory -Destination $applicationDirectory -Recurse -Force
}

$launcherSource = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private static Process server;
    private static NotifyIcon tray;
    private static readonly string Address = "http://127.0.0.1:3000";

    private static void StopServer()
    {
        try
        {
            if (server != null && !server.HasExited)
                server.Kill();
        }
        catch (InvalidOperationException) { }
    }

    private static bool IsStudioReady()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(Address + "/api/status");
            request.Method = "GET";
            request.Timeout = 700;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return response.StatusCode == HttpStatusCode.OK
                    && reader.ReadToEnd().Contains("\"localAvailable\":true");
        }
        catch (WebException) { return false; }
        catch (IOException) { return false; }
    }

    private static void OpenDashboard()
    {
        Process.Start(new ProcessStartInfo(Address) { UseShellExecute = true });
    }

    [STAThread]
    private static int Main()
    {
        bool createdNew;
        using (var mutex = new Mutex(true, "TraumaticStudiosDesktopLauncher", out createdNew))
        {
            if (!createdNew)
            {
                OpenDashboard();
                return 0;
            }

            var applicationDirectory = AppDomain.CurrentDomain.BaseDirectory;
            var nodePath = Path.Combine(applicationDirectory, "runtime", "node.exe");
            var serverPath = Path.Combine(applicationDirectory, "server.js");
            if (!File.Exists(nodePath) || !File.Exists(serverPath))
            {
                MessageBox.Show("The app files are incomplete. Please rebuild the Desktop app.", "Traumatic Studios");
                return 1;
            }

            if (IsStudioReady())
            {
                OpenDashboard();
                return 0;
            }

            var startInfo = new ProcessStartInfo(nodePath, "\"server.js\"")
            {
                WorkingDirectory = applicationDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                server = Process.Start(startInfo);
                if (server == null)
                    throw new InvalidOperationException("The bundled server process could not be started.");

                var ready = false;
                for (var attempt = 0; attempt < 80; attempt++)
                {
                    if (server.HasExited)
                        break;
                    if (IsStudioReady())
                    {
                        ready = true;
                        break;
                    }
                    Thread.Sleep(250);
                }

                if (!ready)
                {
                    StopServer();
                    MessageBox.Show("Traumatic Studios could not start on port 3000. Check whether another app is using that port.", "Traumatic Studios");
                    return 1;
                }

                var iconPath = Path.Combine(applicationDirectory, "Traumatic Studios.ico");
                var menu = new ContextMenuStrip();
                menu.Items.Add("Open Traumatic Studios", null, (sender, args) => OpenDashboard());
                menu.Items.Add("Quit (stop server)", null, (sender, args) => Application.Exit());
                tray = new NotifyIcon
                {
                    Icon = File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application,
                    Text = "Traumatic Studios",
                    ContextMenuStrip = menu,
                    Visible = true
                };
                tray.DoubleClick += (sender, args) => OpenDashboard();

                server.EnableRaisingEvents = true;
                server.Exited += (sender, args) => Application.Exit();

                OpenDashboard();
                Application.Run();
                tray.Visible = false;
                tray.Dispose();
                StopServer();
                return 0;
            }
            catch (Exception error)
            {
                StopServer();
                MessageBox.Show("Traumatic Studios could not start: " + error.Message, "Traumatic Studios");
                return 1;
            }
        }
    }
}
'@

$temporaryExecutable = Join-Path ([IO.Path]::GetTempPath()) ("traumatic-studios-" + [guid]::NewGuid().ToString("N") + ".exe")
try {
  Add-Type -TypeDefinition $launcherSource -OutputAssembly $temporaryExecutable -OutputType WindowsApplication -ReferencedAssemblies System.Windows.Forms,System.Drawing -ErrorAction Stop
  Copy-Item -LiteralPath $temporaryExecutable -Destination (Join-Path $applicationDirectory "Traumatic Studios.exe") -Force
} finally {
  Remove-Item -LiteralPath $temporaryExecutable -Force -ErrorAction SilentlyContinue
}

$readme = @'
Traumatic Studios Desktop

Open "Traumatic Studios.exe" in this folder, or use the shortcut on your Desktop.
The app opens its local dashboard in your browser. Keep the console window open
while using the studio; close it or press Ctrl+C to stop the local server.

This folder includes its own Node.js runtime and can run the offline demo without
an API key. Saved projects are kept in the projects folder next to this app.
Live AI is unavailable until a key is configured for the process; never put a key
in source files or share it in chat.

Dashboard: http://127.0.0.1:3000
'@
Set-Content -LiteralPath (Join-Path $applicationDirectory "START HERE.txt") -Value $readme -Encoding UTF8

$shortcutPath = Join-Path $desktopDirectory "Traumatic Studios.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $applicationDirectory "Traumatic Studios.exe"
$shortcut.WorkingDirectory = $applicationDirectory
$shortcut.Description = "Start the local Traumatic Studios game-development dashboard"
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Save()

Write-Output "Desktop app: $(Join-Path $applicationDirectory 'Traumatic Studios.exe')"
Write-Output "Desktop shortcut: $shortcutPath"
Write-Output "Bundled Node runtime: $((Get-Item (Join-Path $runtimeDirectory 'node.exe')).Length) bytes"
Write-Output "Preserved projects: $((Get-ChildItem -LiteralPath $projectDirectory -Directory | Measure-Object).Count)"
