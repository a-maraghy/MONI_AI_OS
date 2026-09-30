"use strict";
/*
 * MINT AI ▸ Settings ▸ Voice, in the browser: the "Read replies aloud" switch,
 * which is this browser's own choice -- localStorage "mint-read-aloud", the
 * same one the Command Center's speaker button switches and reads at start.
 * Nothing is sent to the server. Without JavaScript (or storage) the switch
 * just shows off.
 */
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
