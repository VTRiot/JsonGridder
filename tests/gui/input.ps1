param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][ValidateSet('info', 'click', 'send', 'rightclick', 'close', 'buttons', 'press', 'openfile', 'splash')][string]$Action,
  [string]$Keys = ''
)
# Real OS input for the application window. Key events sent over the debug protocol
# do not trigger browser accelerators, so reload tests must go through the OS.
# Window titles are read by the tests, so the output must keep Japanese text intact.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class GuiNative {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  public static List<IntPtr> TopLevel() {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => { found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, s.Capacity); return s.ToString(); }
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, s.Capacity); return s.ToString(); }
}
"@

$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x20
$WS_EX_TOOLWINDOW = 0x80
$DIALOG_CLASS = '#32770'
$TEXT_SERVICE_CLASSES = @('IME', 'MSCTFIME UI')
$WM_CLOSE = 0x0010
$TDM_CLICK_BUTTON = 0x0400 + 102
$TASK_DIALOG_FIRST_BUTTON_ID = 100 # FIRST_BUTTON_ID of src-tauri/src/shell/task_dialog.rs
$TASK_DIALOG_BUTTON_IDS = 'CommandButton_*'
$FILE_NAME_BOX_ID = 1148 # The file name box of the common file dialog
$WM_SETTEXT = 0x000C
$WM_COMMAND = 0x0111
$IDOK = 1
$SPLASH_TITLE = 'JsonGridder-splash' # SPLASH_TITLE of src-tauri/src/splash.rs

function Get-AutomationRoot($h) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  return [System.Windows.Automation.AutomationElement]::FromHandle($h)
}

function Get-Buttons($root) {
  # The buttons of a task dialog are panes to UI Automation. Only their ids tell them apart.
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  return @($all | Where-Object { $_.Current.AutomationId -like $TASK_DIALOG_BUTTON_IDS })
}

function Get-OwnerPid($h) {
  [uint32]$owner = 0
  [void][GuiNative]::GetWindowThreadProcessId($h, [ref]$owner)
  return [int]$owner
}

function Get-Size($h) {
  $r = New-Object GuiNative+RECT
  [void][GuiNative]::GetWindowRect($h, [ref]$r)
  return @{ Width = $r.R - $r.L; Height = $r.B - $r.T }
}

function Get-UserWindows {
  # The windowing library keeps a transparent event window with WS_VISIBLE set, and hidden windows exist
  # before the application shows itself. A window the user can see has a title, a size and takes clicks.
  $windows = @()
  foreach ($h in [GuiNative]::TopLevel()) {
    if ((Get-OwnerPid $h) -ne $TargetPid) { continue }
    if (-not [GuiNative]::IsWindowVisible($h)) { continue }
    $title = [GuiNative]::Text($h)
    if ($title.Length -eq 0) { continue }
    # The splash screen is not the application window. Only the splash action looks at it.
    if ($title -eq $SPLASH_TITLE) { continue }
    $class = [GuiNative]::Class($h)
    if ($TEXT_SERVICE_CLASSES -contains $class) { continue }
    if (([GuiNative]::GetWindowLong($h, $GWL_EXSTYLE) -band ($WS_EX_TRANSPARENT -bor $WS_EX_TOOLWINDOW)) -ne 0) { continue }
    $size = Get-Size $h
    if ($size.Width -le 0 -or $size.Height -le 0) { continue }
    $windows += [pscustomobject]@{ Handle = $h; Title = $title; Class = $class }
  }
  return $windows
}

function Set-Foreground($h) {
  # Sharing the input queue of the current foreground thread lifts the foreground lock without sending any
  # input. No keys or clicks may go out before the check below, because they would reach another application.
  $front = [GuiNative]::GetForegroundWindow()
  if ($front -ne $h) {
    [uint32]$ignored = 0
    $frontThread = [GuiNative]::GetWindowThreadProcessId($front, [ref]$ignored)
    $ownThread = [GuiNative]::GetCurrentThreadId()
    $attached = $frontThread -ne 0 -and [GuiNative]::AttachThreadInput($ownThread, $frontThread, $true)
    [void][GuiNative]::BringWindowToTop($h)
    [void][GuiNative]::SetForegroundWindow($h)
    if ($attached) { [void][GuiNative]::AttachThreadInput($ownThread, $frontThread, $false) }
    Start-Sleep -Milliseconds 300
  }
  # Input goes to whichever window is in front, so stop here instead of typing into another application.
  if ([GuiNative]::GetForegroundWindow() -eq $h) { Write-Output 'FOREGROUND=1' } else { Write-Output 'FOREGROUND=0'; exit 0 }
}

function Move-ToCenter($h) {
  $r = New-Object GuiNative+RECT
  [void][GuiNative]::GetWindowRect($h, [ref]$r)
  [void][GuiNative]::SetCursorPos([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2))
  Start-Sleep -Milliseconds 150
}

function Get-ProcessTree {
  # The WebView2 browser processes that draw the default menu are descendants of the application.
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = @{ $TargetPid = $true }
  do {
    $added = $false
    foreach ($item in $all) {
      if ($ids.ContainsKey([int]$item.ParentProcessId) -and -not $ids.ContainsKey([int]$item.ProcessId)) {
        $ids[[int]$item.ProcessId] = $true
        $added = $true
      }
    }
  } while ($added)
  return $ids
}

function Test-OwnForeground($ids) {
  # An open menu can take the foreground. It still belongs to the application, unlike any other window.
  $front = [GuiNative]::GetForegroundWindow()
  return $front -ne [IntPtr]::Zero -and $ids.ContainsKey((Get-OwnerPid $front))
}

function Get-TreeWindows($ids) {
  # Visible top-level windows of the application and its browser processes, keyed by handle.
  $windows = @{}
  foreach ($h in [GuiNative]::TopLevel()) {
    if (-not [GuiNative]::IsWindowVisible($h)) { continue }
    if (-not $ids.ContainsKey((Get-OwnerPid $h))) { continue }
    $size = Get-Size $h
    $windows[[string]$h] = '{0}:{1}x{2}' -f [GuiNative]::Class($h), $size.Width, $size.Height
  }
  return $windows
}

$p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if ($null -eq $p) { Write-Output 'PROCESS=0'; exit 0 }
Write-Output 'PROCESS=1'

if ($Action -eq 'splash') {
  # Report the splash screen of this process by its title, class and size. Nothing is sent to it.
  foreach ($h in [GuiNative]::TopLevel()) {
    if ((Get-OwnerPid $h) -ne $TargetPid) { continue }
    if (-not [GuiNative]::IsWindowVisible($h)) { continue }
    if ([GuiNative]::Text($h) -ne $SPLASH_TITLE) { continue }
    $size = Get-Size $h
    Write-Output 'SPLASH=1'
    Write-Output ('SPLASH_CLASS=' + [GuiNative]::Class($h))
    Write-Output ('SPLASH_SIZE={0}x{1}' -f $size.Width, $size.Height)
    exit 0
  }
  Write-Output 'SPLASH=0'
  exit 0
}

$windows = @(Get-UserWindows)
if ($windows.Count -eq 0) { Write-Output 'WINDOW=0'; Write-Output 'VISIBLE=0'; exit 0 }
# A dialog blocks the window behind it, so it is the one that takes the input.
$window = @($windows | Where-Object { $_.Class -eq $DIALOG_CLASS })[0]
if ($null -eq $window) { $window = $windows[0] }
$h = $window.Handle
Write-Output 'WINDOW=1'
Write-Output 'VISIBLE=1'
Write-Output ('TITLE=' + $window.Title)
Write-Output ('CLASS=' + $window.Class)
$rect = New-Object GuiNative+RECT
[void][GuiNative]::GetWindowRect($h, [ref]$rect)
Write-Output ('RECT={0},{1},{2},{3}' -f $rect.L, $rect.T, ($rect.R - $rect.L), ($rect.B - $rect.T))

switch ($Action) {
  'info' { }
  'close' {
    # The message the close button sends. It needs no input, so the foreground does not matter.
    [void][GuiNative]::PostMessage($h, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
  }
  'buttons' {
    $names = @(Get-Buttons (Get-AutomationRoot $h) | ForEach-Object { $_.Current.Name })
    if ($names.Count -eq 0) {
      # A later dialog on the same thread can show an empty tree from its handle. The owner's tree still lists it.
      $main = @($windows | Where-Object { $_.Class -ne $DIALOG_CLASS })[0]
      if ($null -ne $main) { $names = @(Get-Buttons (Get-AutomationRoot $main.Handle) | ForEach-Object { $_.Current.Name }) }
    }
    Write-Output ('BUTTONS=' + ($names -join '|'))
  }
  'press' {
    # $Keys is the button's position. The panes offer no invoke pattern, and the dialog message works on
    # this dialog alone, so no input is sent.
    if ($window.Class -ne $DIALOG_CLASS) { Write-Output 'PRESSED=0'; exit 0 }
    $id = $TASK_DIALOG_FIRST_BUTTON_ID + [int]$Keys
    [void][GuiNative]::PostMessage($h, $TDM_CLICK_BUTTON, [IntPtr]$id, [IntPtr]::Zero)
    Write-Output 'PRESSED=1'
  }
  'openfile' {
    # Walking this dialog with UI Automation visits every file of the folder, which takes too long.
    $box = [GuiNative]::FindWindowEx([GuiNative]::GetDlgItem($h, $FILE_NAME_BOX_ID), [IntPtr]::Zero, 'ComboBox', $null)
    $edit = [GuiNative]::FindWindowEx($box, [IntPtr]::Zero, 'Edit', $null)
    if ($edit -eq [IntPtr]::Zero) { Write-Output 'PRESSED=0'; exit 0 }
    [void][GuiNative]::SendMessage($edit, $WM_SETTEXT, [IntPtr]::Zero, $Keys)
    [void][GuiNative]::PostMessage($h, $WM_COMMAND, [IntPtr]$IDOK, [IntPtr]::Zero)
    Write-Output 'PRESSED=1'
  }
  'click' {
    Set-Foreground $h
    Move-ToCenter $h
    [GuiNative]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
    [GuiNative]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
  'send' {
    Set-Foreground $h
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Start-Sleep -Milliseconds 300
  }
  'rightclick' {
    Set-Foreground $h
    Move-ToCenter $h
    $ids = Get-ProcessTree
    $before = Get-TreeWindows $ids
    [GuiNative]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)
    [GuiNative]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 900
    $after = Get-TreeWindows (Get-ProcessTree)
    $opened = @($after.Keys | Where-Object { -not $before.ContainsKey($_) } | ForEach-Object { $after[$_] })
    # The default menu is its own top-level window of the browser process. Its items are not
    # listed by UI Automation, and walking the whole desktop takes longer than the input timeout.
    Write-Output ('OPENED=' + ($opened -join '|'))
    # Keys chosen by the test go to the menu. Without keys the menu is closed.
    if ($Keys -eq '') { $followUp = '{ESC}' } else { $followUp = $Keys }
    if (Test-OwnForeground (Get-ProcessTree)) {
      Write-Output 'FOLLOWUP=1'
      [System.Windows.Forms.SendKeys]::SendWait($followUp)
    } else {
      Write-Output 'FOLLOWUP=0'
    }
    Start-Sleep -Milliseconds 200
  }
}
