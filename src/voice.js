// Push-to-talk speech recognition using Windows' built-in offline speech engine.
const { runPowerShell } = require('./tools');

const SCRIPT = `
Add-Type -AssemblyName System.Speech
$rec = $null
foreach ($c in @('en-GB','en-US')) {
  try { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine ([System.Globalization.CultureInfo]::new($c)); break } catch {}
}
if (-not $rec) { $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine }
$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$rec.SetInputToDefaultAudioDevice()
$rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(7)
$rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.0)
$rec.BabbleTimeout = [TimeSpan]::FromSeconds(4)
$r = $rec.Recognize([TimeSpan]::FromSeconds(25))
if ($r) { [Console]::Out.Write($r.Text) }
$rec.Dispose()
`;

let busy = false;

async function listenOnce() {
  if (busy) return { ok: false, message: 'Already listening.' };
  busy = true;
  try {
    const r = await runPowerShell(SCRIPT, { timeoutS: 40 });
    const text = r.stdout.trim();
    if (text) return { ok: true, text };
    if (r.stderr.trim()) {
      return {
        ok: false,
        message: /recognizer|culture/i.test(r.stderr)
          ? 'Windows speech recognition is not installed. Settings > Time & language > Speech, add an English speech pack.'
          : 'Microphone error: ' + r.stderr.trim().split('\n')[0],
      };
    }
    return { ok: false, message: "Didn't catch that." };
  } finally {
    busy = false;
  }
}

module.exports = { listenOnce };
