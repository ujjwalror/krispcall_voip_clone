"use strict";
(() => {
  // chrome-extension/src/storage.ts
  function isStorageAvailable() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome?.runtime?.id) && Boolean(chrome?.storage?.local);
    } catch {
      return false;
    }
  }
  async function safeStorageGet(keys) {
    if (!isStorageAvailable()) {
      console.warn("[VoIP Hub Storage] Extension context invalidated or storage unavailable");
      return { success: false, invalidated: true, error: "Extension context invalidated" };
    }
    try {
      return await new Promise((resolve) => {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime?.lastError) {
            const err = chrome.runtime.lastError.message || "chrome.storage.local.get failed";
            console.error("[VoIP Hub Storage] Read error:", err);
            resolve({ success: false, invalidated: false, error: err });
          } else {
            resolve({ success: true, invalidated: false, value: result || {} });
          }
        });
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error("[VoIP Hub Storage] Exception reading storage:", msg);
      return { success: false, invalidated: false, error: msg };
    }
  }

  // chrome-extension/src/config.ts
  var SERVER_BASE = "https://krispcall-voip-clone-udlg.vercel.app";

  // chrome-extension/src/background.ts
  var dialerWindowId = null;
  async function openOrFocusDialerWindow(crmContext) {
    if (dialerWindowId !== null) {
      try {
        const existingWin = await chrome.windows.get(dialerWindowId);
        if (existingWin) {
          console.log("[VoIP Hub BG] Focusing existing dialer window:", dialerWindowId);
          await chrome.windows.update(dialerWindowId, { focused: true });
          if (crmContext) {
            chrome.runtime.sendMessage({ type: "LOAD_CRM_CONTEXT", data: crmContext }).catch(() => {
            });
          }
          return dialerWindowId;
        }
      } catch {
        dialerWindowId = null;
      }
    }
    console.log("[VoIP Hub BG] Creating primary VoIP Hub dialer window...");
    const createdWin = await chrome.windows.create({
      url: "dialer-window.html",
      type: "popup",
      width: 380,
      height: 640,
      focused: true
    });
    dialerWindowId = createdWin?.id || null;
    console.log("[VoIP Hub BG] Primary dialer window created with ID:", dialerWindowId);
    if (crmContext) {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "LOAD_CRM_CONTEXT", data: crmContext }).catch(() => {
        });
      }, 800);
    }
    return dialerWindowId || 0;
  }
  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === dialerWindowId) {
      console.log("[VoIP Hub BG] Primary dialer window closed by user");
      dialerWindowId = null;
    }
  });
  chrome.action.onClicked.addListener(() => {
    console.log("[VoIP Hub BG] Extension toolbar icon clicked -> opening/focusing dialer window");
    openOrFocusDialerWindow();
  });
  async function fetchBusinessNumbersForExtension() {
    try {
      const storageRes = await safeStorageGet(["voiphub_ext_token"]);
      if (!storageRes.success || storageRes.invalidated || !storageRes.value?.voiphub_ext_token) return [];
      const token = storageRes.value.voiphub_ext_token;
      const res = await fetch(`${SERVER_BASE}/api/extension/phone-numbers`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        return data.phoneNumbers || [];
      }
    } catch (err) {
      console.warn("[VoIP Hub BG] Business numbers proxy notice:", err);
    }
    return [];
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }
    if (message.type === "INITIATE_CALL_FROM_CRM") {
      console.log("[VoIP Hub BG] INITIATE_CALL_FROM_CRM received:", message.data);
      openOrFocusDialerWindow(message.data);
      sendResponse({ success: true, windowId: dialerWindowId });
      return false;
    } else if (message.type === "FETCH_BUSINESS_NUMBERS") {
      fetchBusinessNumbersForExtension().then((numbers) => {
        sendResponse({ success: true, phoneNumbers: numbers });
      });
      return true;
    } else if (message.type === "FOCUS_DIALER_WINDOW") {
      openOrFocusDialerWindow(message.data);
      sendResponse({ success: true });
      return false;
    }
    return false;
  });
})();
