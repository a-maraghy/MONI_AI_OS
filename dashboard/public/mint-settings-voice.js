"use strict";
/*
 * MINT AI ▸ Settings ▸ Voice, in the browser: the "Read replies aloud" switch,
 * which is this browser's own choice -- localStorage "mint-read-aloud", the
 * same one the Command Center's speaker button switches and reads at start.
 * Nothing is sent to the server. Without JavaScript (or storage) the switch
 * just shows off. Also: the line under the Voice model and Transcription
 * selectors follows the option chosen (the form itself is posted by os.js).
 */
(function () {
  [
    ["voice-transcriber", "voice-transcriber-hint"],
    ["voice-model", "voice-model-hint"],
  ].forEach(function (ids) {
    var pick = document.getElementById(ids[0]);
    var hint = document.getElementById(ids[1]);
    if (!pick || !hint) return;
    pick.addEventListener("change", function () {
      var o = pick.options[pick.selectedIndex];
      hint.textContent = (o && o.getAttribute("data-hint")) || "";
    });
  });
})();
(function () {
  var box = document.querySelector("[data-read-aloud]");
  if (!box) return;
  var KEY = "mint-read-aloud";
  try {
    box.checked = window.localStorage.getItem(KEY) === "1";
  } catch (e) {
    box.disabled = true;
    return;
  }
  box.addEventListener("change", function () {
    try {
      window.localStorage.setItem(KEY, box.checked ? "1" : "0");
    } catch (e) {
      box.checked = !box.checked;
    }
  });
})();
