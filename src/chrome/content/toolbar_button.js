window.addEventListener("load", https_everywhere_load, true);
window.addEventListener("load", function load(event) {
  // need to wrap migratePreferences in another callback so that notification
  // always displays on browser restart
  window.removeEventListener("load", load, false);
  gBrowser.addEventListener("DOMContentLoaded", migratePreferences, true);
}, false);

const CI = Components.interfaces;
const CC = Components.classes;

// LOG LEVELS ---
VERB=1;
DBUG=2;
INFO=3;
NOTE=4;
WARN=5;

HTTPSEverywhere = CC["@eff.org/https-everywhere;1"]
                      .getService(Components.interfaces.nsISupports)
                      .wrappedJSObject;

// avoid polluting global namespace
// see: https://developer.mozilla.org/en-US/docs/Security_best_practices_in_extensions#Code_wrapping
if (!httpsEverywhere) { var httpsEverywhere = {}; }

/**
 * JS Object that acts as a namespace for the toolbar.
 *
 * Used to display toolbar hints to new users and change toolbar UI for cases
 * such as when the toolbar is disabled.
 */
httpsEverywhere.toolbarButton = {
  
  /**
   * Name of the preference for enabling/disabling the ruleset updater.
   */
  RULESET_UPDATER_PREF: "extensions.https_everywhere.ruleset_updater.enabled",

  /**
   * Name of preference for determining whether to show ruleset counter.
   */
  COUNTER_PREF: "extensions.https_everywhere.show_counter",

  /**
   * Name of preference for whether HTTP Nowhere is on.
   */
  HTTP_NOWHERE_PREF: "extensions.https_everywhere.http_nowhere.enabled",

  /**
   * Used to determine if a hint has been previously shown.
   * TODO: Probably extraneous, look into removing
   */
  hintShown: false,

  /**
   * Initialize the toolbar button used to hint new users and update UI on
   * certain events.
   */
  init: function() {
    HTTPSEverywhere.log(DBUG, 'Removing listener for toolbarButton init.');
    window.removeEventListener('load', httpsEverywhere.toolbarButton.init, false);

    var tb = httpsEverywhere.toolbarButton;

    // Now that HTTPSE has been initialized, start the ruleset updater if enabled.
    var rulesetUpdaterEnabled = Services.prefs.getBoolPref(tb.RULESET_UPDATER_PREF);
    if (rulesetUpdaterEnabled) {
      HTTPSEverywhere.start_ruleset_updater();
    }

    // make sure the checkbox for showing counter is properly set
    var showCounter = tb.shouldShowCounter();
    var counterItem = document.getElementById('https-everywhere-counter-item');
    counterItem.setAttribute('checked', showCounter ? 'true' : 'false');

    // make sure UI for HTTP Nowhere mode is properly set
    var httpNowhereItem = document.getElementById('http-nowhere-item');
    var showHttpNowhere = tb.shouldShowHttpNowhere();
    var toolbarbutton = document.getElementById('https-everywhere-button');
    httpNowhereItem.setAttribute('checked', showHttpNowhere ? 'true' : 'false');
    toolbarbutton.setAttribute('http_nowhere',
                               showHttpNowhere ? 'true' : 'false');

    // make sure UI for ruleset updater toggle is properly set
    var rulesetUpdaterItem = document.getElementById('ruleset-updater-item');
    rulesetUpdaterItem.setAttribute('checked', rulesetUpdaterEnabled.toString());

    // make sure UI is set depending on whether HTTPS-E is enabled
    toggleEnabledUI();

    // show ruleset counter when a tab is changed
    tb.updateRulesetsApplied();
    gBrowser.tabContainer.addEventListener(
      'TabSelect', 
      tb.updateRulesetsApplied, 
      false
    );

    // hook event for when page loads
    var onPageLoad = function() {
      // Timeout is used for a number of reasons.
      // 1) For Performance since we want to defer computation.
      // 2) Sometimes the page is loaded before all applied rulesets are
      //    calculated; in such a case, a half-second wait works.
      setTimeout(tb.updateRulesetsApplied, 500);
    };

    var appcontent = document.getElementById('appcontent');
    if (appcontent) {
      appcontent.addEventListener('load', onPageLoad, true);
    }

    // decide whether to show toolbar hint
    let hintPref = "extensions.https_everywhere.toolbar_hint_shown";
    if (!Services.prefs.getPrefType(hintPref) 
        || !Services.prefs.getBoolPref(hintPref)) { 
      // only run once
      Services.prefs.setBoolPref(hintPref, true);
      gBrowser.addEventListener("DOMContentLoaded", tb.handleShowHint, true);
    }
  },

  /**
   * Shows toolbar hint if previously not shown.
   */
  handleShowHint: function() {
    var tb = httpsEverywhere.toolbarButton;
    if (!tb.hintShown){
      tb.hintShown = true;
      const faqURL = "https://www.eff.org/https-everywhere/faq";
      var nBox = gBrowser.getNotificationBox();
      var strings = document.getElementById('HttpsEverywhereStrings');
      var msg = strings.getString('https-everywhere.toolbar.hint');
      var hint = nBox.appendNotification(
        msg, 
        'https-everywhere', 
        'chrome://https-everywhere/skin/https-everywhere-24.png', 
        nBox.PRIORITY_WARNING_MEDIUM,
	[],
	function(action) {
	  // see https://developer.mozilla.org/en-US/docs/XUL/Method/appendNotification#Notification_box_events
	  gBrowser.selectedTab = gBrowser.addTab(faqURL);
	}
      );
    }
    gBrowser.removeEventListener("DOMContentLoaded", tb.handleShowHint, true);
  },


  /**
   * Update the rulesets applied counter for the current tab.
   */
  updateRulesetsApplied: function() {
    var toolbarbutton = document.getElementById('https-everywhere-button');
    var enabled = HTTPSEverywhere.prefs.getBoolPref("globalEnabled");
    var showCounter = httpsEverywhere.toolbarButton.shouldShowCounter();
    if (!enabled || !showCounter) { 
      toolbarbutton.setAttribute('rulesetsApplied', 0);
      return;
    }

    var domWin = content.document.defaultView.top;
    var alist = HTTPSEverywhere.getExpando(domWin,"applicable_rules", null);
    if (!alist) {
      return;
    }
    // Make sure the list is up to date
    alist.populate_list();

    var counter = 0;
    for (var x in alist.active) {
      if (!(x in alist.breaking)) {
        ++counter;
      }
    }
    for (var x in alist.moot) {
      if (!(x in alist.active)) {
        ++counter;
      }
    }

    toolbarbutton.setAttribute('rulesetsApplied', counter);
    HTTPSEverywhere.log(INFO, 'Setting icon counter to: ' + counter);
  },

  /**
   * Gets whether to show the rulesets applied counter.
   *
   * @return {boolean}
   */
  shouldShowCounter: function() {
    var tb = httpsEverywhere.toolbarButton;
    var sp = Services.prefs;

    var prefExists = sp.getPrefType(tb.COUNTER_PREF);

    // the default behavior is to show the rulesets applied counter.
    // if no preference exists (default) or its enabled, show the counter
    return !prefExists || sp.getBoolPref(tb.COUNTER_PREF);
  },

  /**
   * Gets whether to show HTTP Nowhere UI.
   *
   * @return {boolean}
   */
  shouldShowHttpNowhere: function() {
    var tb = httpsEverywhere.toolbarButton;
    var sp = Services.prefs;
    return sp.getBoolPref(tb.HTTP_NOWHERE_PREF);
  },

  /**
   * Toggles the user's preference for displaying the rulesets applied counter
   * and updates the UI.
   */
  toggleShowCounter: function() {
    var tb = httpsEverywhere.toolbarButton;
    var sp = Services.prefs;

    var showCounter = tb.shouldShowCounter();
    sp.setBoolPref(tb.COUNTER_PREF, !showCounter);

    tb.updateRulesetsApplied();
  },

  /**
   * Toggles whether HTTP Nowhere mode is active, updates the toolbar icon.
   */
  toggleHttpNowhere: function() {
    HTTPSEverywhere.toggleHttpNowhere();
    var tb = httpsEverywhere.toolbarButton;
    var showHttpNowhere = tb.shouldShowHttpNowhere();

    // Change icon color to red if HTTP nowhere is enabled
    var toolbarbutton = document.getElementById('https-everywhere-button');
    toolbarbutton.setAttribute('http_nowhere',
                               showHttpNowhere ? 'true' : 'false');
    reload_window();
  }
};

function https_everywhere_load() {
  window.removeEventListener('load', https_everywhere_load, true);
  // on first run, put the context menu in the addons bar and make sure that the
  // rulesets database file has been copied to the profile directory so it can be
  // replaced and reinitialized by the ruleset updater.
  try {
    var first_run;
    try {
      first_run = Services.prefs.getBoolPref("extensions.https_everywhere.firstrun_context_menu");
    } catch(e) {
      Services.prefs.setBoolPref("extensions.https_everywhere.firstrun_context_menu", true);
      first_run = true;
    }
    if(first_run) {
      Services.prefs.setBoolPref("extensions.https_everywhere.firstrun_context_menu", false);
      var navbar = document.getElementById("nav-bar");
      if(navbar.currentSet.indexOf("https-everywhere-button") == -1) {
        var set = navbar.currentSet+',https-everywhere-button';
        navbar.setAttribute('currentset', set);
        navbar.currentSet = set;
        document.persist('nav-bar', 'currentset');
      }
      // The original rulesets.sqlite file created when the addon is built
      var dbFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
      dbFile.initWithPath(
        HTTPSEverywhere.instance.rw.chromeToPath(
          'chrome://https-everywhere/content/rulesets.sqlite'));
      // The volatile copy of the rulesets file
      var dbFileVol = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
      dbFileVol.initWithPath(
        HTTPSEverywhere.instance.RULESET_DATABASE_FILE());
      if (dbFile.exists()) {
        if (!dbFileVol.exists()) {
          dbFile.copyTo(
            dbFileVol.parent, 
            OS.Path.basename(HTTPSEVerywhere.instance.RULESET_DATABASE_FILE()));
        }
        // TODO
        // Might not want to delete the original rulesets database here 
        dbFile.remove();
      }
    }
  } catch(e) { }
}

function stitch_context_menu() {
  // the same menu appears both under Tools and via the toolbar button:
  var menu = document.getElementById("https-everywhere-menu");
  if (!menu.firstChild) {
    var popup = document.getElementById("https-everywhere-context");
    menu.appendChild(popup.cloneNode(true));
  }
}
function stitch_context_menu2() {
  // the same menu appears both under Tools and via the toolbar button:
  var menu = document.getElementById("https-everywhere-menu2");
  if (!menu.firstChild) {
    var popup = document.getElementById("https-everywhere-context");
    menu.appendChild(popup.cloneNode(true));
  }
}

var rulesetTestsMenuItem = null;

function show_applicable_list(menupopup) {
  var domWin = content.document.defaultView.top;
  if (!(domWin instanceof CI.nsIDOMWindow)) {
    alert(domWin + " is not an nsIDOMWindow");
    return null;
  }

  var alist = HTTPSEverywhere.getExpando(domWin,"applicable_rules", null);
  var weird=false;
  
  if (!alist) {
    // This case occurs for error pages and similar.  We need a dummy alist
    // because populate_menu lives in there.  Would be good to refactor this
    // away.
    alist = new HTTPSEverywhere.ApplicableList(HTTPSEverywhere.log, document, domWin);
    weird = true;
  }
  alist.populate_menu(document, menupopup, weird);

  // should we also show the ruleset tests menu item?
  if(HTTPSEverywhere.prefs.getBoolPref("show_ruleset_tests")) {

    if(!rulesetTestsMenuItem) {
      let strings = document.getElementById('HttpsEverywhereStrings');
      let label = strings.getString('https-everywhere.menu.ruleset-tests');

      rulesetTestsMenuItem = this.document.createElement('menuitem');
      rulesetTestsMenuItem.setAttribute('command', 'https-everywhere-menuitem-ruleset-tests');
      rulesetTestsMenuItem.setAttribute('label', label);
    }

    if(!menupopup.contains(rulesetTestsMenuItem)) 
      menupopup.appendChild(rulesetTestsMenuItem);
  }
  
}

function toggle_rule(rule_id) {
  // toggle the rule state
  HTTPSEverywhere.https_rules.rulesetsByID[rule_id].toggle();
  var domWin = content.document.defaultView.top;
  /*if (domWin instanceof CI.nsIDOMWindow) {
    var alist = HTTPSEverywhere.getExpando(domWin,"applicable_rules", null);
    if (alist) alist.empty();
  }*/
  reload_window();
}

function reload_window() {
  var domWin = content.document.defaultView.top;
  if (!(domWin instanceof CI.nsIDOMWindow)) {
    HTTPSEverywhere.log(WARN, domWin + " is not an nsIDOMWindow");
    return null;
  }
  try {
    var webNav =  domWin.QueryInterface(CI.nsIInterfaceRequestor)
                        .getInterface(CI.nsIWebNavigation)
                        .QueryInterface(CI.nsIDocShell);
  } catch(e) {
    HTTPSEverywhere.log(WARN,"failed to get webNav");
    return null;
  }
  // The choice of LOAD_FLAGS_CHARSET_CHANGE comes from NoScript's quickReload
  // function; not sure if it's optimal
  let flags = webNav.LOAD_FLAGS_BYPASS_CACHE & webNav.LOAD_FLAGS_CHARSET_CHANGE;
  webNav.reload(flags);
}

function toggleEnabledState(){
	HTTPSEverywhere.toggleEnabledState();
	reload_window();
  toggleEnabledUI();
}

function toggleEnabledUI() {
  // Add/remove menu items depending on whether HTTPS-E is enabled
  var items = document.querySelectorAll(".hide-on-disable");
  var enabled = HTTPSEverywhere.prefs.getBoolPref("globalEnabled");
  for (let i = 0; i < items.length; i++) {
    items[i].hidden = !enabled;
  }

  // Change icon depending on enabled state
  var toolbarbutton = document.getElementById('https-everywhere-button');
  toolbarbutton.setAttribute('status', enabled ? 'enabled' : 'disabled');
}

function open_in_tab(url) {
  var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
                     .getService(Components.interfaces.nsIWindowMediator);
  var recentWindow = wm.getMostRecentWindow("navigator:browser");
  recentWindow.delayedOpenTab(url, null, null, null, null);
}

// hook event for showing hint
HTTPSEverywhere.log(DBUG, 'Adding listener for toolbarButton init.');
window.addEventListener("load", httpsEverywhere.toolbarButton.init, false);

function migratePreferences() {
  gBrowser.removeEventListener("DOMContentLoaded", migratePreferences, true);
  let prefs_version = HTTPSEverywhere.prefs.getIntPref("prefs_version");
  
  // first migration loses saved prefs
  if(prefs_version == 0) {
    try {
      // upgrades will have old rules as preferences, such as the EFF rule
      let upgrade = false;
      let childList = HTTPSEverywhere.prefs.getChildList("", {});
      for(let i=0; i<childList.length; i++) {
        if(childList[i] == 'EFF') {
          upgrade = true;
          break;
        }
      }

      if(upgrade) {
        let nBox = gBrowser.getNotificationBox();
        let strings = document.getElementById('HttpsEverywhereStrings');
        let msg = strings.getString('https-everywhere.migration.notification0');
        nBox.appendNotification(
          msg, 
          'https-everywhere-migration0', 
          'chrome://https-everywhere/skin/https-everywhere-24.png', 
          nBox.PRIORITY_WARNING_MEDIUM
        );
      }
    } catch(e) {
      HTTPSEverywhere.log(WARN, "Migration from prefs_version 0 error: "+e);
    }

    HTTPSEverywhere.prefs.setIntPref("prefs_version", prefs_version+1);
  }
}

