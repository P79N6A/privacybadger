/*
 *
 * This file is part of Privacy Badger <https://www.eff.org/privacybadger>
 * Copyright (C) 2014 Electronic Frontier Foundation
 *
 * Derived from Adblock Plus
 * Copyright (C) 2006-2013 Eyeo GmbH
 *
 * Derived from Chameleon <https://github.com/ghostwords/chameleon>
 * Copyright (C) 2015 ghostwords
 *
 * Privacy Badger is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Privacy Badger is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Privacy Badger.  If not, see <http://www.gnu.org/licenses/>.
 */

require.scopes.storage = (function() {

/*********************** webrequest scope **/

/************ Local Variables *****************/
// var DomainExceptions = require("domainExceptions").DomainExceptions;
var Utils = require("utils").Utils;
var pbStorage = require("storage");
var temporarySocialWidgetUnblock = {};
var tabData = {};
/**
 * Per-tab data that gets cleaned up on tab closing
   looks like:
    tabData = {
      <tab_id>: {
        fpData: {
          <script_origin>: {
            canvas: {
              fingerprinting: boolean,
              write: boolean
            }
          },
          ...
        },
        frames: {
          <frame_id>: {
            url: string,
            parent: int
          },
          ...
        },
        trackers: {
          domain.tld: bool
          ...
        }
      },
      ...
    } 
*/


/*************** Register Event Listeners *********************/
chrome.webRequest.onBeforeRequest.addListener(onBeforeRequest, {urls: ["http://*/*", "https://*/*"]}, ["blocking"]);
chrome.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, {urls: ["http://*/*", "https://*/*"]}, ["requestHeaders", "blocking"]);
chrome.webRequest.onHeadersReceived.addListener(onHeadersReceived, {urls: ["<all_urls>"]}, ["responseHeaders", "blocking"]);
chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onReplaced.addListener(onTabReplaced);

/***************** Blocking Listener Functions **************/

/**
 * Event handling of http requests, main logic to collect data what to block
 *
 * @param details The event details
 * @returns {*} Can cancel requests
 */
function onBeforeRequest(details){
  if (details.tabId == -1){
    return {};
  }

  var type = details.type;
  if (type == "main_frame"){
    forgetTab(details.tabId);
  }

  if (type == "main_frame" || type == "sub_frame"){
    recordFrame(details.tabId, details.frameId, details.parentFrameId, details.url);
  }

  var tabDomain = getHostForTab(details.tabId);
  var requestDomain = window.extractHostFromURL(details.url);
   
  if (Utils.isPrivacyBadgerDisabled(tabDomain)) {
    return {};
  }

  if (!window.isThirdParty(requestDomain, tabDomain)) {
    return {};
  }

  // read the supercookie state from localStorage and store it in frameData
  // TODO: Reimplement supercookie stuff using storage.js
  /*
  var frameData = getFrameData(details.tabId, details.frameId);
  if (frameData && !("superCookie" in frameData)){ // check if we already read localStorage for this frame
    var supercookieDomains = Utils.getSupercookieDomains();
    var origin = window.getBaseDomain(window.extractHostFromURL(details.url));
    frameData.superCookie = supercookieDomains[origin] ? true : false;
    //console.log("onBeforeRequest: read superCookie state from localstorage for",
    //    origin, frameData.superCookie, details.tabId, details.frameId);
  } 
  */
  var requestAction = checkAction(details.tabId, details.url, false, details.frameId);
  if (requestAction) {
    // TODO: reimplement whitelist request stuff in storage.js
    //add domain to list of blocked domains if it is not there already
    /*
    if(requestAction == "block" || requestAction == "cookieblock"){

      //if settings for this domain are still controlled by badger and it is in
      //the list of domain exceptions ask the user if they would like to unblock.
      if(requestAction.indexOf('user') < 0){
        var whitelistAry = DomainExceptions.getWhitelistForPath(details.url);
        if( whitelistAry){
          _askUserToWhitelist(details.tabId, whitelistAry.whitelist_urls, whitelistAry.english_name);
        }
      }

    }
    */

    if (requestAction == window.BLOCK || requestAction == window.USER_BLOCK) {
      // Notify the content script...
      var msg = {
        replaceSocialWidget: true,
        trackerDomain: window.extractHostFromURL(details.url)
      };
      chrome.tabs.sendMessage(details.tabId, msg);

      return {cancel: true};
    }
  }

}

/**
 * Filters outgoing cookies and referer
 * Injects DNT
 *
 * @param details Event details
 * @returns {*} modified headers
 */
function onBeforeSendHeaders(details) {
  var tabDomain = getHostForTab(details.tabId);
  var requestDomain = window.extractHostFromURL(details.url);

  if (details.tabId == -1){
    return {};
  }

  if(_isTabChromeInternal(details.tabId)){
    return {};
  }

  if (Utils.isPrivacyBadgerEnabled(tabDomain) && 
      window.isThirdParty(requestDomain, tabDomain)) {
    var requestAction = checkAction(details.tabId, details.url, false, details.frameId);
    if (requestAction) {
      if (requestAction == window.COOKIEBLOCK || requestAction == window.USER_COOKIE_BLOCK) {
        var newHeaders = details.requestHeaders.filter(function(header) {
          return (header.name.toLowerCase() != "cookie" && header.name.toLowerCase() != "referer");
        });
        newHeaders.push({name: "DNT", value: "1"});
        return {requestHeaders: newHeaders};
      }
    }
  }

  // Still sending Do Not Track even if HTTP and cookie blocking are disabled
  details.requestHeaders.push({name: "DNT", value: "1"});
  return {requestHeaders: details.requestHeaders};
}

/**
 * Filters incoming cookies out of the response header
 *
 * @param details The event details
 * @returns {*} The new response header
 */
function onHeadersReceived(details){
  var tabDomain = getHostForTab(details.tabId);
  var requestDomain = window.extractHostFromURL(details.url);
  if (details.tabId == -1){
    return {};
  }
   
  if (Utils.isPrivacyBadgerDisabled(tabDomain)) {
    return {};
  }

  if (!window.isThirdParty(requestDomain, tabDomain)) {
    return {};
  }

  if(_isTabChromeInternal(details.tabId)){
    return {};
  }

  var requestAction = checkAction(details.tabId, details.url, false, details.frameId);
  if (requestAction) {
    if (requestAction == window.COOKIEBLOCK || requestAction == window.USER_COOKIE_BLOCK) {
      var newHeaders = details.responseHeaders.filter(function(header) {
        return (header.name.toLowerCase() != "set-cookie");
      });
      newHeaders.push({name:'x-marks-the-spot', value:'foo'});
      //TODO don't return this unless we modified headers
      return {responseHeaders: newHeaders};
    }
  }
}

/*************** Non-blocking listener functions ***************/

/**
 * Event handler when a tab gets removed
 *
 * @param {Integer} tabId Id of the tab
 */
function onTabRemoved(tabId){
  forgetTab(tabId);
}

/**
 * Update internal db on tabs when a tab gets replaced
 *
 * @param {Integer} addedTabId The new tab id that replaces
 * @param {Integer} removedTabId The tab id that gets removed
 */
function onTabReplaced(addedTabId, removedTabId){
  forgetTab(removedTabId);
  // Update the badge of the added tab, which was probably used for prerendering.
  window.updateBadge(addedTabId);
}

/******** Utility Functions **********/

/**
 * Gets the host name for a given tab id
 * @param {Integer} tabId chrome tab id
 * @return {String} the host name for the tab
 */
function getHostForTab(tabId){
  var mainFrameIdx = 0;
  if (!tabData[tabId]) {
    return;
  }
  if (_isTabAnExtension(tabId)) {
    // If the tab is an extension get the url of the first frame for its implied URL
    // since the url of frame 0 will be the hash of the extension key
    mainFrameIdx = Object.keys(tabData[tabId].frames)[1] || 0;
  }
  if (!tabData[tabId].frames[mainFrameIdx]) {
    return;
  }
  return window.extractHostFromURL(tabData[tabId].frames[mainFrameIdx].url);
}

/**
 * Generate representation in internal data structure for frame
 *
 * @param tabId ID of the tab
 * @param frameId ID of the frame
 * @param parentFrameId ID of the parent frame
 * @param frameUrl The url of the frame
 */
function recordFrame(tabId, frameId, parentFrameId, frameUrl) {
  if (!tabData.hasOwnProperty(tabId)){
    tabData[tabId] = {
      frames: {},
      trackers: {}
    };
  }
  // check if this is a prerendered (bg) tab or not
  chrome.tabs.get(tabId, function(/*tab*/){
    if (chrome.runtime.lastError){
      // chrome will throw error for the prerendered tabs
      tabData[tabId].bgTab = true;
    }else{
      tabData[tabId].bgTab = false;
    }
  });

  tabData[tabId].frames[frameId] = {
    url: frameUrl,
    parent: parentFrameId
  };
}

/**
 * Store super cookie data in memory. Also stored in Local Storage
 *
 * @param sender message sender
 * @param msg super cookie message dict
 */
function recordSuperCookie(sender, msg) {
  // TODO: Use storage.js for this
  /* Update frameData and localStorage about the supercookie finding */
  var frameHost = window.extractHostFromURL(msg.docUrl); // docUrl: url of the frame with supercookie
  var frameOrigin = window.getBaseDomain(frameHost);
  var pageHost = window.extractHostFromURL(getFrameUrl(sender.tab.id, 0));
  if (!window.isThirdParty(frameHost, pageHost)) {
    // only happens on the start page for google.com.
    return;
  }

  // keep frame's supercookie state in frameData for faster lookups
  var frameData = getFrameData(sender.tab.id, sender.frameId);
  if (frameData){
    // console.log("Adding", frameOrigin, "to supercookieDomains (frameData), found on", pageHost);
    frameData.superCookie = true;
  }
  // now add the finding to localStorage for persistence
  var supercookieDomains = Utils.getSupercookieDomains();
  // We could store the type of supercookie once we start to check multiple storage vectors
  // Could be useful for debugging & bookkeeping.
  //console.log("Adding", frameOrigin, "to supercookieDomains (localStorage), found on", pageHost);
  supercookieDomains[frameOrigin] = true;
  localStorage.setItem("supercookieDomains", JSON.stringify(supercookieDomains));
}

/**
 * Record canvas fingerprinting
 *
 * @param {Integer} tabId
 * @param msg specific fingerprinting data
 */
function recordFingerprinting(tabId, msg) {
  // TODO: Investigate whether this should use storage.js
  // bail if we failed to determine the originating script's URL
  // TODO find and fix where this happens
  if (!msg.scriptUrl) {
    return;
  }

  // ignore first-party scripts
  var script_host = window.extractHostFromURL(msg.scriptUrl),
    document_host = window.extractHostFromURL(getFrameUrl(tabId, 0));
  if (!window.isThirdParty(script_host, document_host)) {
    return;
  }

  var CANVAS_WRITE = {
    fillText: true,
    strokeText: true
  };
  var CANVAS_READ = {
    getImageData: true,
    toDataURL: true
  };

  if (!tabData[tabId].hasOwnProperty('fpData')) {
    tabData[tabId].fpData = {};
  }

  var script_origin = window.getBaseDomain(script_host);

  // initialize script TLD-level data
  if (!tabData[tabId].fpData.hasOwnProperty(script_origin)) {
    tabData[tabId].fpData[script_origin] = {
      canvas: {
        fingerprinting: false,
        write: false
      }
    };
  }
  var scriptData = tabData[tabId].fpData[script_origin];

  if (msg.extra.hasOwnProperty('canvas')) {
    if (scriptData.canvas.fingerprinting) {
      return;
    }

    // if this script already had a canvas write
    if (scriptData.canvas.write) {
      // and if this is a canvas read
      if (CANVAS_READ.hasOwnProperty(msg.prop)) {
        // and it got enough data
        if (msg.extra.width > 16 && msg.extra.height > 16) {
          // let's call it fingerprinting
          scriptData.canvas.fingerprinting = true;

          // mark this is a strike
          window.recordPrevalence(
            script_host, script_origin, window.getBaseDomain(document_host));
        }
      }
      // this is a canvas write
    } else if (CANVAS_WRITE.hasOwnProperty(msg.prop)) {
      scriptData.canvas.write = true;
    }
  }
}


/**
 * read the frame data from memory
 *
 * @param tabId TabId to check for
 * @param frameId FrameID to check for
 * @returns {*} Frame data object or null
 */
function getFrameData(tabId, frameId) {
  if (tabId in tabData && frameId in tabData[tabId].frames){
    return tabData[tabId].frames[frameId];
  } else if (frameId > 0 && tabId in tabData && 0 in tabData[tabId].frames) {
    // We don't know anything about javascript: or data: frames, use top frame
    return tabData[tabId].frames[0];
  }
  return null;
}

/**
 * Based on tab/frame ids, get the URL
 *
 * @param {Integer} tabId The tab id to look up
 * @param {Integer} frameId The frame id to look up
 * @returns {String} The url
 */
function getFrameUrl(tabId, frameId) {
  var frameData = getFrameData(tabId, frameId);
  return (frameData ? frameData.url : null);
}

/**
 * Delete tab data, de-register tab
 *
 * @param {Integer} tabId The id of the tab
 */
function forgetTab(tabId) {
  delete tabData[tabId];
  delete temporarySocialWidgetUnblock[tabId];
}

/**
 * Determines the action to take on a specific URL.
 *
 * @param {Integer} tabId The relevant tab
 * @param {String} url The URL
 * @param {Boolean} quiet Do not update internal data
 * @param {Integer} frameId The id of the frame
 * @returns {boolean} false or the action to take
 */
function checkAction(tabId, url, quiet, frameId){
  // Ignore requests from temporarily unblocked social widgets.
  // Someone clicked the widget, so let it load.
  if (isSocialWidgetTemporaryUnblock(tabId, url, frameId)) {
    return false;
  }

  // Ignore requests from internal Chrome tabs.
  if (_isTabChromeInternal(tabId)) {
    return false;
  }

  // Ignore requests that don't have a document URL for some reason.
  var documentUrl = getFrameUrl(tabId, 0);
  if (! documentUrl) {
    return false;
  }

  // Ignore requests from private domains.
  var requestHost = window.extractHostFromURL(url);
  var origin = window.getBaseDomain(requestHost);
  if (window.isPrivateDomain(origin)) {
    return false;
  }

  // Ignore requests that aren't from a third party.
  var documentHost = window.extractHostFromURL(documentUrl);
  var thirdParty = window.isThirdParty(requestHost, documentHost);
  if (! thirdParty) {
    return false;
  }

  // Determine action is request is from third party and tab is valid.
  var action;
  if (tabId > -1) {
    action = pbStorage.getBestAction(requestHost);
  }

  if (action && ! quiet) {
    // TODO: Add code to write to popup. Mabye put in tabs?
    //activeMatchers.addMatcherToOrigin(tabId, requestHost, "requestAction", action);
    console.log('ADD', requestHost, 'to popup for', documentUrl, 'with action', action);
  }
  return action;
}

/**
 * Check if the url of the tab starts with the given string
 *
 * @param {Integer} tabId Id of the tab
 * @param {String} piece String to check against
 * @returns {boolean} true if starts with string
 * @private
 */
function _frameUrlStartsWith(tabId, piece){
  return tabData[tabId] &&
    tabData[tabId].frames[0] &&
    (tabData[tabId].frames[0].url.indexOf(piece) === 0);
}

/**
 * Checks if the tab is chrome internal
 *
 * @param {Integer} tabId Id of the tab to test
 * @returns {boolean} Returns true if the tab is chrome internal
 * @private
 */
function _isTabChromeInternal(tabId){
  return _frameUrlStartsWith(tabId, "chrome");
}

/**
 * Checks if the tab is a chrome-extension tab
 *
 * @param {Integer} tabId Id of the tab to test
 * @returns {boolean} Returns true if the tab is from a chrome-extension
 * @private
 */
function _isTabAnExtension(tabId){
  return _frameUrlStartsWith(tabId, "chrome-extension://");
}

/**
 * Ask user what to do with a specific url. Dialog is handled by domainExceptionDialog
 *
 * @param {Integer} tabId The id of the tab
 * @param whitelistDomains dict with whitelist information
 * @param englishName English description for domain
 * @private
 */
/* TODO: reimplement using storage.js
function _askUserToWhitelist(tabId, whitelistDomains, englishName){
  console.log('asking user to whitelist');
  var port = chrome.tabs.connect(tabId);
  port.postMessage({action: 'attemptWhitelist', whitelistDomain:englishName, currentDomain:getHostForTab(tabId)});
  port.onMessage.addListener(function(msg){
    for(var i = 0; i < whitelistDomains.length; i++){
      if(msg.action === "allow_all"){
        saveAction('noaction', whitelistDomains[i]);
        reloadTab(tabId);
      }
      if(msg.action === "allow_once"){
        //allow blag on this site only
        saveAction('noaction', whitelistDomains[i], getHostForTab(tabId));
        reloadTab(tabId);
      }
      if(msg.action === "never"){
        //block third party domain always
        console.log('never allow');
        saveAction('cookieblock', whitelistDomains[i]);
        reloadTab(tabId);
      }
      //if(msg.action === "not_now"){
      //  //do nothing
      //}
    }
  });
}
*/
/**
 * Provides the social widget blocking content script with list of social widgets to block
 *
 * @returns a specific dict
 */
function getSocialWidgetBlockList() {

  // a mapping of individual SocialWidget objects to boolean values
  // saying if the content script should replace that tracker's buttons
  var socialWidgetsToReplace = {};
  var green_domains = pbStorage.getAllDomainsByPresumedAction(window.USER_ALLOW);

  window.SocialWidgetList.forEach(function(socialwidget) {
    var socialWidgetName = socialwidget.name;

    // replace them if the user hasn't greened them
    if (green_domains.indexOf(socialwidget.domain) > -1 ) {
      socialWidgetsToReplace[socialWidgetName] = false;
    } else {
      socialWidgetsToReplace[socialWidgetName] = true;
    }
  });

  return {
    "trackers" : window.SocialWidgetList,
    "trackerButtonsToReplace" : socialWidgetsToReplace,
  };
}

/**
 * Check if tab is temporarily unblocked for tracker
 *
 * @param tabId id of the tab to check
 * @param url url to check
 * @param frameId frame id to check
 * @returns {boolean} true if in exception list
 */
function isSocialWidgetTemporaryUnblock(tabId, url, frameId) {
  var exceptions = temporarySocialWidgetUnblock[tabId];
  if (exceptions === undefined) {
    return false;
  }

  var requestHost = window.extractHostFromURL(url);
  var requestExcept = (exceptions.indexOf(requestHost) != -1);

  var frameHost = window.extractHostFromURL(getFrameUrl(tabId, frameId));
  var frameExcept = (exceptions.indexOf(frameHost) != -1);

  return (requestExcept || frameExcept);
}

/**
 * Unblocks a tracker just temporarily on this tab, because the user has clicked the
 * corresponding replacement social widget.
 *
 * @param {Integer} tabId The id of the tab
 * @param {Array} socialWidgetUrls an array of social widget urls
 */
function unblockSocialWidgetOnTab(tabId, socialWidgetUrls) {
  if (temporarySocialWidgetUnblock[tabId] === undefined){
    temporarySocialWidgetUnblock[tabId] = [];
  }
  for (var i in socialWidgetUrls) {
    var socialWidgetUrl = socialWidgetUrls[i];
    var socialWidgetHost = window.extractHostFromURL(socialWidgetUrl);
    temporarySocialWidgetUnblock[tabId].push(socialWidgetHost);
  }
}

/**
 * Handle the different tracker variants. The big dispatcher
 */
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  var tabHost = window.extractHostFromURL(sender.tab.url);

  if (request.checkEnabled) {
    sendResponse(Utils.isPrivacyBadgerEnabled(tabHost));

  } else if (request.checkLocation) {
    if (Utils.isPrivacyBadgerEnabled(tabHost)) {
      var documentHost = request.checkLocation.href;
      var reqAction = checkAction(sender.tab.id, documentHost, true);
      var cookieBlock = reqAction == window.COOKIEBLOCK || reqAction == window.USER_COOKIE_BLOCK;
      sendResponse(cookieBlock);
    }

  } else if (request.checkReplaceButton) {
    if (Utils.isPrivacyBadgerEnabled(tabHost) && Utils.isSocialWidgetReplacementEnabled()) {
      var socialWidgetBlockList = getSocialWidgetBlockList();
      sendResponse(socialWidgetBlockList);
    }
  } else if (request.unblockSocialWidget) {
    var socialWidgetUrls = request.buttonUrls;
    unblockSocialWidgetOnTab(sender.tab.id, socialWidgetUrls);
    sendResponse();

  // canvas fingerprinting
  } else if (request.fpReport) {
    if (Array.isArray(request.fpReport)) {
      request.fpReport.forEach(function (msg) {
        recordFingerprinting(sender.tab.id, msg);
      });
    } else {
      recordFingerprinting(sender.tab.id, request.fpReport);
    }

  } else if (request.superCookieReport) {
    if (Utils.hasSuperCookie(request.superCookieReport)){
      recordSuperCookie(sender, request.superCookieReport);
    }
  } else if (request.checkEnabledAndThirdParty) {
    var pageHost = window.extractHostFromURL(sender.url);
    sendResponse(Utils.isPrivacyBadgerEnabled(tabHost) && window.isThirdParty(pageHost, tabHost));
  } else if (request.checkSocialWidgetReplacementEnabled) {
    sendResponse(Utils.isPrivacyBadgerEnabled(tabHost) && Utils.isSocialWidgetReplacementEnabled());
  }

});

var exports = {};

return exports;
/************************************** exports */
})();
