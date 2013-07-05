define(["esri/map",
		"esri/arcgis/Portal",
		"esri/arcgis/utils",
		"esri/dijit/Legend",
		"storymaps/utils/Helper",
		// Core
		"storymaps/swipe/core/Config",
		"storymaps/swipe/core/Data",
		"storymaps/swipe/core/WebApplicationData",
		"storymaps/swipe/core/SwipeHelper",
		// UI
		"storymaps/ui/header/Header",
		"storymaps/ui/mapCommand/MapCommand",
		"dojo/has"],
	function(Map,
				Portal,
				Utils,
				Legend,
				Helper,
				Config,
				Data,
				WebApplicationData,
				SwipeHelper,
				Header,
				MapCommand,
				has)
	{
		/**
		 * Core
		 * @class Core
		 *
		 * Main controller
		 */
		
		// Development options
		// Values are enforced at build time
		var CONFIG = {
			environment: "TPL_ENV_DEV" // TPL_ENV_DEV || TPL_ENV_PRODUCTION
		};
		
		var _mainView = null;

		//
		// Initialization
		//

		function init(mainView, builder)
		{
			console.log("swipe.core.Core - init");
			
			_mainView = mainView;
			
			initLocalization();
			
			var isInBuilderMode = builder != null && Helper.getAppID(isProd()) != null;

			if( ! Config.checkConfigFileIsOK() ) {
				initError("invalidConfig");
				return;
			}
			
			// Application global object
			app = {
				map: null,
				maps: [],
				mapResponse: [],
				currentMapIndex: -1,
				// esri.arcgis.Portal
				portal: null,
				// Data model
				mode: "TWO_LAYERS",
				layout: "swipe",
				data: new Data(),
				// Builder
				builder: builder,
				isInBuilderMode: isInBuilderMode,
				// UI
				header: new Header("#header", isInBuilderMode),
				// Flags
				loadingTimeout: null,
				initInProgress: false,
				// Config
				config: {
					//
				}
			};
			
			if ( ! _mainView.init(this) )
				return;
			
			if ( true && !isProd() ) {
				dojo.connect(esri.id, 'onDialogCreate', function(){
					dojo.connect(esri.id.dialog, 'onShow', function(){
						esri.id.dialog.txtUser_.set('value', 'guest');
						esri.id.dialog.txtPwd_.set('value', 'guest');
						esri.id.dialog.btnSubmit_.onClick();
					});
				});
			}
			
			startLoadingTimeout();

			// Set the Portal
			// - if configOptions.sharingurl is set use that URL
			// - if app is not on *.arcgis.com : use AGO
			// - otherwise use the web server name and port
			if (!configOptions.sharingurl) {
				configOptions.sharingurl = location.protocol + '//' + location.host + "/sharing/content/items";
			}
			else
				configOptions.sharingurl = location.protocol + configOptions.sharingurl;

			if (commonConfig && commonConfig.helperServices && commonConfig.helperServices.geometry)
				esri.config.defaults.geometryService = new esri.tasks.GeometryService(commonConfig.helperServices.geometry.url);

			configOptions.proxyurl = configOptions.proxyurl ? location.protocol + configOptions.proxyurl : location.protocol + '//' + location.host + "/sharing/proxy";

			esri.arcgis.utils.arcgisUrl = configOptions.sharingurl;
			esri.config.defaults.io.proxyUrl = configOptions.proxyurl;
			
			// Allow IE9 to save over HTTP
			esri.id && esri.id.setProtocolErrorHandler(function(){ return true; });
			
			// USE CORS to save the web app configuration during developement
			if( isInBuilderMode && APPCFG.CORS_SERVER ) {
				$.each(APPCFG.CORS_SERVER, function(i, server){
					esriConfig.defaults.io.corsEnabledServers.push(server);
				});
			}
						
			// Set a variable timeout deping on the application mode
			if( isInBuilderMode )
				esri.config.defaults.io.timeout = APPCFG.TIMEOUT_BUILDER_REQUEST;
			else
				esri.config.defaults.io.timeout = APPCFG.TIMEOUT_VIEWER_REQUEST;
			
			// Run the app when jQuery is ready
			$(document).ready( dojo.hitch(this, initStep2) );
		}

		function initStep2()
		{
			console.log("swipe.core.Core - initStep2");
					
			// Initialize localization
			app.header.initLocalization();
			_mainView.initLocalization();

			$(window).resize(handleWindowResize);
			
			// Disable form submit on enter key
			$("form").bind("keydown", function(e) {
				if (e.keyCode == 13)
					return false;
			});

			var appId = Helper.getAppID(isProd());
			var webmapsIds = Helper.getWebmapsIDs(isProd()).slice(0, 2);
			WebApplicationData.setWebmaps(webmapsIds);
	
			// Basic styling in case something isn't public
			dojo.connect(esri.id, "onDialogCreate", styleIdentityManager);
			
			dojo.subscribe("CORE_UPDATE_UI", updateUI);
			dojo.subscribe("CORE_RESIZE", handleWindowResize);
			
			loadingIndicator.setMessage(i18n.viewer.loading.step2);
			
			// Load using a Web Mapping Application item
			if (appId)
				loadWebMappingApp(appId);
			else if (webmapsIds && webmapsIds.length == 2) 
				loadWebmapsIds(webmapsIds);
			// Load using a webmap: preview or user hosted
			else 
				if (webmapsIds.length || webmapId) 
					loadWebMap(webmapsIds[0]);
				else 
					initError("invalidConfigNoWebmap");
		}

		function loadWebMappingApp(appId)
		{
			console.log("swipe.core.Core - loadWebMappingApp - appId:", appId);
			
			var urlParams = esri.urlToObject(document.location.search).query || {};
			var forceLogin = urlParams.forceLogin != undefined;
			
			// If forceLogin parameter in URL
			//  OR development
			//  OR production and there is a cookie -> sign in the user by reusing the cookie
			//  OR production, builder and no esri cookie -> shoud always redirect to portal login page
			if ( forceLogin || ! isProd() || (isProd() && Helper.getPortalUser()) || (isProd() && app.isInBuilderMode && ! Helper.getPortalUser()) )
				portalLogin().then(
					function() {						
						loadWebMappingAppStep2(appId);
					}, 
					function() { 
						initError("notAuthorized");
					}
				);
			// Production in user mode without cookie or dev in view/edit
			else
				loadWebMappingAppStep2(appId);
		}
		
		function loadWebMappingAppStep2(appId)
		{
			// Get application item
			var itemRq = esri.request({
				url: configOptions.sharingurl + "/" + appId + "",
				content: {
					f: "json"
				},
				callbackParamName: "callback",
				load: function (response) {
					app.data.setAppItem(response);
				},
				error: function() { }
			});

			// Get application config
			var dataRq = esri.request({
				url: configOptions.sharingurl + "/" + appId + "/data",
				content: {
					f: "json"
				},
				callbackParamName: "callback",
				load: function (response) {
					WebApplicationData.set(response);
				},
				error: function(){ }
			});
			
			var appDeferedList = new dojo.DeferredList([itemRq, dataRq]);
			appDeferedList.then(function(){
				if (!dataRq.results || !dataRq.results[0] || !itemRq.results || !itemRq.results[0]) {
					if( itemRq.results && itemRq.results[1] && itemRq.results[1] && itemRq.results[1].httpCode == 403 )
						initError("notAuthorized");
					else
						initError("invalidApp");
					return;
				}

				var webmapsIds = WebApplicationData.getWebmaps();
				
				if( app.isInBuilderMode && ! app.data.userIsAppOwnerOrAdmin() ) {
					initError("notAuthorized");	
					return;
				}
				
				if (webmapsIds && webmapsIds.length == 2 && WebApplicationData.getDataModel() == "TWO_WEBMAPS")
					loadWebmapsIds(webmapsIds);
				else if (webmapsIds && WebApplicationData.getDataModel() && WebApplicationData.getLayers() != null)
					loadWebMap(webmapsIds[0]);
				else if (webmapsIds && app.isInBuilderMode)
					loadWebMap(webmapsIds[0]);
				else if (webmapsIds && ! app.isInBuilderMode) {
					if( app.data.userIsAppOwnerOrAdmin() ){
						loadingIndicator.setMessage(i18n.viewer.loading.loadBuilder);
						setTimeout(function(){
							app.header.switchToBuilder();
						}, 1200);
					}
					else
						initError("noLayerView");
				}
				else
					initError("invalidApp");
			});
		}
		
		function openInitPopup()
		{
			if( $("#initPopup").is(':visible') )
				return;	
			
			cleanLoadingTimeout();
			app.initInProgress = true;
			initError("initMobile", null, true);
			handleWindowResize();
			
			var resultDeferred = app.builder.presentInitPopup();
			resultDeferred.then(
				function()
				{
					app.initInProgress = false;
					prepareAppForWebmapReload();
					
					var webmapsIds = WebApplicationData.getWebmaps();
					if (webmapsIds && webmapsIds.length == 2)
						loadWebmapsIds(WebApplicationData.getWebmaps());
					else
						loadWebMap(webmapsIds[0]);
				},
				function()
				{
					replaceInitErrorMessage("noLayerView");
					$("#loadingOverlay").css("top", "0px");
					$("#header").css("display", "inherit");
					$("#fatalError").css("display", "block");
					
					app.initInProgress = false;
					handleWindowResize();
				}
			);
		}
		
		function portalLogin()
		{
			var resultDeferred = new dojo.Deferred();
			var portalUrl = configOptions.sharingurl.split('/sharing/')[0];
			app.portal = new esri.arcgis.Portal(portalUrl);

			dojo.connect(esri.id, "onDialogCreate", styleIdentityManagerForLoad);
			app.portal.signIn().then(
				function() {
					resultDeferred.resolve();
				},
				function(error) {
					resultDeferred.reject();
				}
			);
			
			return resultDeferred;
		}
		
		function loadWebmapsIds(webmapsIds)
		{
			if (WebApplicationData.getWebmaps().length == 2) {
				app.mode = "TWO_WEBMAPS";
			}
			
			var webmapsDeferred = [];
			$.each(webmapsIds, function(i, webmapId){
				webmapsDeferred.push(loadWebMap(webmapId, i));
			});
			
			new dojo.DeferredList(webmapsDeferred).then(function(){
				setTimeout(_mainView.webmapLoaded, 0);
			});
		}

		function loadWebMap(webmapId, index)
		{
			console.log("swipe.core.Core - loadWebMap - webmapId:", webmapId, index);
			index = index || 0;
				
			var divId = "mainMap" + index;
			if( index == 1  && WebApplicationData.getLayout() == "spyglass" && app.mode == "TWO_WEBMAPS")
				divId = "lensMapNode";	
			
			var mapDeferred = esri.arcgis.utils.createMap(webmapId, divId, {
				mapOptions: {
					slider: divId != "lensMapNode",
					autoResize: false,
					infoWindow: app.popup[index],
					showAttribution: divId != "lensMapNode"
				},
				ignorePopups: false,
				bingMapsKey: commonConfig.bingMapsKey
			});

			var webmapInitCallbackDone = new dojo.Deferred();
			
			mapDeferred.addCallback(function(response){
				// Workaround a debug limitation
				setTimeout(function(){ webMapInitCallback(response, webmapInitCallbackDone); }, 0);
			});
			mapDeferred.addErrback(function(){
				
				initError("createMap");
			});
			
			return webmapInitCallbackDone;
		}
		
		function getWebmapIndex(webmapId)
		{
			return $.inArray(webmapId, Helper.getWebmapsIDs(isProd()));
		}

		function webMapInitCallback(response, webmapInitCallbackDone)
		{
			console.log("swipe.core.Core - webMapInitCallback");			
			if( app.mode == "TWO_WEBMAPS" ){
				var index = $.inArray(response.itemInfo.item.id, WebApplicationData.getWebmaps());//getWebmapIndex(response.itemInfo.item.id);
				app.mapResponse[index] = response;
				app.maps[index] = response.map;
				
				if (index == 0) {
					app.data.setWebMapItem(response.itemInfo);
					app.map = response.map;
				}
				else {
					webmapInitCallbackDone.resolve();
				}
				
				if (WebApplicationData.getLegend() || configOptions.legend) {
					//Put the resize map legend on the left (seems counter-intuitive)
					if (app.mode == "TWO_WEBMAPS" && WebApplicationData.getLayout() == "swipe") {
						if (index == 0) {
							var legend1 = new Legend({
								map: app.maps[0],
								layerInfos: (esri.arcgis.utils.getLegendLayers(response))
							}, "legend1");
							legend1.startup();
						}
						else {
							var legend0 = new Legend({
								map: app.maps[1],
								layerInfos: (esri.arcgis.utils.getLegendLayers(response))
							}, "legend0");
							legend0.startup();
						}
					}
					else{
						if (index == 0) {
							var legend0 = new Legend({
								map: app.maps[0],
								layerInfos: (esri.arcgis.utils.getLegendLayers(response))
							}, "legend0");
							legend0.startup();
						}
						else {
							var legend1 = new Legend({
								map: app.maps[1],
								layerInfos: (esri.arcgis.utils.getLegendLayers(response))
							}, "legend1");
							legend1.startup();
						}
					}			
				}
					
			}
			else {
				app.maps = [response.map];
				app.data.setWebMapItem(response.itemInfo);
				// Check that the layer is found in the webmap or select the last layer
				var layer = app.maps[0].getLayer(WebApplicationData.getLayers()[0]) || {};
				var layerId = layer.id;
				var layersIds = (app.maps[0].layerIds || []).concat(app.maps[0].graphicsLayerIds);
				var layerFound = $.grep(layersIds, function(_layerId) { return _layerId == layerId; });
				
				if( ! layerFound.length ) {
					layerId = (app.maps[0].layerIds||[]).concat(app.maps[0].graphicsLayerIds).slice(-1);
					layer = app.maps[0].getLayer(layerId);
					WebApplicationData.setLayers(layerId);
				}
				
				if(WebApplicationData.getLegend() || configOptions.legend){
					var layerTitle = layer && layer.arcgisProps && layer.arcgisProps.title ? layer.arcgisProps.title : (layer && layer.name ? layer.name : layer);
					var layers = esri.arcgis.utils.getLegendLayers(response);

					var legend0Layer = $.grep(layers, function(item){
						return item.title != layerTitle;
					});
					
					var legend1Layer = $.grep(layers, function(item){
						return item.title == layerTitle;
					});
					
					var legend0 = new Legend({
							map: app.maps[0],
							layerInfos: legend0Layer
						}, "legend0");
					legend0.startup();
					
					var legend1 = new Legend({
							map: app.maps[0],
							layerInfos: legend1Layer
						}, "legend1");
					legend1.startup();
				}
			}
			
			// Initialize header
			// Title/subtitle are the first valid string from: index.html config object, web application data, web map data
			var title = configOptions.title || WebApplicationData.getTitle() || response.itemInfo.item.title;
			var subtitle = configOptions.subtitle || WebApplicationData.getSubtitle() || response.itemInfo.item.snippet;
			
			applyUILayout(WebApplicationData.getLayout() || configOptions.layout);
			handleWindowResize();

			var appColors = WebApplicationData.getColors();
			var logoURL = WebApplicationData.getLogoURL() || APPCFG.HEADER_LOGO_URL;
			var logoTarget = (logoURL == APPCFG.HEADER_LOGO_URL) ? APPCFG.HEADER_LOGO_TARGET : WebApplicationData.getLogoTarget();
			
			app.header.init(
				title,
				subtitle,
				appColors[0],
				logoURL,
				logoTarget,
				! app.isInBuilderMode && Helper.getAppID() && (! isProd() || app.data.userIsAppOwnerOrAdmin()),
				WebApplicationData.getHeaderLinkText() == undefined ? APPCFG.HEADER_LINK_TEXT : WebApplicationData.getHeaderLinkText(),
				WebApplicationData.getHeaderLinkURL() == undefined ? APPCFG.HEADER_LINK_URL : WebApplicationData.getHeaderLinkURL()
			);
			document.title = $('<div>' + title + '</div>').text();
			
			try {
				webmapInitCallbackDone.resolve();
			}
			catch(e){
				//
			}
			
			if( app.isInBuilderMode && WebApplicationData.getWebmaps().length != 2 && ! WebApplicationData.getDataModel() ) {
				dojo.connect(app.maps[0], "onUpdateEnd", openInitPopup);
				// TODO: the screen reappear if the user spend less than 6s on the init screen
				setTimeout(openInitPopup, 6000);
				return;
			}
			else if( app.mode == "TWO_LAYERS" )
				setTimeout(_mainView.webmapLoaded, 0);
		}

		function appInitComplete()
		{
			console.log("swipe.core.Core - initMap");
			
			var index = 0;
			if(WebApplicationData.getLayout() == "swipe" && app.mode == "TWO_WEBMAPS")
				index = 1;
			// with map
			// Map command buttons
			new MapCommand(
				app.maps[index], 
				function(){
					app.maps[0].setExtent(Helper.getWebMapExtentFromItem(app.data.getWebMapItem().item));
				},
				_mainView.zoomToDeviceLocation
				//app.isInBuilderMode ? _mainView.zoomToDeviceLocation : null
			);

			// Resize everything after picture has been set
			handleWindowResize();

			// On mobile, force start on the Map view except if it's the intro
			if (location.hash)
				location.hash = "map";

			// On mobile, change view based on browser history
			window.onhashchange = function(e){				
				// If no hash and there is intro data, it's init, so skip
				if( (location.hash == "" || location.hash == "#")  && app.data.getIntroData() )
					return;
				
				prepareMobileViewSwitch();

				if(location.hash == "#map") {
				 	$("#mapViewLink").addClass("current");
					showMobileViewMap();
				}
				else
					_mainView.onHashChange();
			}
			
			_mainView.appInitComplete();
		}
		
		function displayApp()
		{
			// Show the app is the timeout hasn't be fired			
			if( app.loadingTimeout != null ) {
				$("#loadingOverlay").fadeOut();
				loadingIndicator.stop();
			}
			
			cleanLoadingTimeout();
		}

		function initError(error, message, noDisplay)
		{	
			hideUI();
			cleanLoadingTimeout();
			loadingIndicator.stop();
			
			if( error == "noLayerView" ) {
				loadingIndicator.setMessage(i18n.viewer.errors[error], true);
				return;
			}
			else if ( ! error == "initMobile" )
				loadingIndicator.forceHide();

			$("#fatalError .error-msg").html(i18n.viewer.errors[error]);
			if( ! noDisplay ) 
				$("#fatalError").show();
		}
		
		function replaceInitErrorMessage(error)
		{
			$("#fatalError .error-msg").html(i18n.viewer.errors[error]);
		}
		
		//
		// UI
		//
		
		function applyUILayout(layout)
		{
			$("body").toggleClass("modern-layout", layout == "integrated");
		}

		/**
		 * Refresh the UI when tour points have changed
		 */
		function updateUI()
		{
			console.log("swipe.core.Core - updateUI");
			
			var appColors = WebApplicationData.getColors();
			
			applyUILayout(WebApplicationData.getLayout());
			
			// TODO: app title/subtitle are not restored
			
			app.header.setColor(appColors[0]);
			
			var logoURL = WebApplicationData.getLogoURL() || APPCFG.HEADER_LOGO_URL;
			app.header.setLogoInfo(
				logoURL,
				logoURL == APPCFG.HEADER_LOGO_URL ? 
					APPCFG.HEADER_LOGO_TARGET 
					: WebApplicationData.getLogoTarget()
			);
			app.header.setTopRightLink(
				WebApplicationData.getHeaderLinkText() == undefined ? APPCFG.HEADER_LINK_TEXT : WebApplicationData.getHeaderLinkText(),
				WebApplicationData.getHeaderLinkURL() == undefined ? APPCFG.HEADER_LINK_URL : WebApplicationData.getHeaderLinkURL()
			);
			
			_mainView.updateUI();
			
			handleWindowResize();
		}

		function handleWindowResize()
		{
			var isMobileView = SwipeHelper.isOnMobileView();
			var isOnMobileMapView = $("#mapViewLink").hasClass("current");
			
			if( isMobileView )
				$("body").addClass("mobile-view");
			else
				$("body").removeClass("mobile-view");

			var widthViewport = $("body").width();
			var heightViewport = $("body").height();
			var heightHeader = $("#header").height();
			var heightMiddle = heightViewport - heightHeader;
			
			app.header.resize(widthViewport);
			
			_mainView.resize({
				isMobileView: isMobileView,
				isOnMobileMapView: isOnMobileMapView,
				width: widthViewport,
				height: heightMiddle
			});

			$("#contentPanel").height(heightMiddle);
			$("#contentPanel").width(widthViewport);

			// Force a browser reflow by reading #picturePanel width 
			// Using the value computed in desktopPicturePanel.resize doesn't works
			$("#mapPanel").width( widthViewport - $("#picturePanel").width() );
			
			if (app.isInBuilderMode){
				app.builder.resize({
					isMobileView: isMobileView
				});
			}
			
			if (! isMobileView || (isMobileView && isOnMobileMapView)){
				try {
					if ( app.maps[0] )
						app.maps[0].resize(true);
					else if ( app.maps[1] && app.mode != "TWO_WEBMAPS" && app.layout != "spyglass" )
						app.maps[1].resize(true);
				} catch( e ) { }
			}
			
			// Change esri logo size
			if( isMobileView )
				$("#mainMap .esriControlsBR > div").first().removeClass("logo-med").addClass("logo-sm");
			else
				$("#mainMap .esriControlsBR > div").first().removeClass("logo-sm").addClass("logo-med");
		}
		
		//
		// Login in dev environnement
		//
		
		function styleIdentityManager()
		{
			// Override for bootstrap conflicts
			$(".esriSignInDialog td label").siblings("br").css("display", "none");
			$(".esriSignInDialog .dijitDialogPaneContentArea div:nth(1)").css("display", "none");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("padding", "0px");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("margin-bottom", "0px");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("border", "none");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("border-radius", "0px");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("-webkit-border-radius", "0px");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("-moz-border-radius", "0px");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("box-shadow", "none");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("-webkit-box-shadow", "none");
			$(".esriSignInDialog .dijitReset.dijitInputInner").css("-moz-box-shadow", "none");
			$(".esriSignInDialog .dijitReset.dijitValidationContainer").css("display", "none");
			$(".esriSignInDialog .esriErrorMsg").css("margin-top", "10px");

			// Edit title
			$(".esriSignInDialog").find(".dijitDialogTitleBar").find(".dijitDialogTitle").first().html("Authentication is required");

			// Hide default message
			$(".esriSignInDialog").find(".dijitDialogPaneContentArea:first-child").find(":first-child").first().css("display", "none");

			// Setup a more friendly text
			$(".esriSignInDialog").find(".dijitDialogPaneContentArea:first-child").find(":first-child").first().after("<div id='dijitDialogPaneContentAreaLoginText'>Please sign in with an account on <a href='http://" + esri.id._arcgisUrl + "' title='" + esri.id._arcgisUrl + "' target='_blank'>" + esri.id._arcgisUrl + "</a> to access the application.</div>");
		}
		
		function styleIdentityManagerForLoad()
		{
			// Hide default message
			$(".esriSignInDialog").find("#dijitDialogPaneContentAreaLoginText").css("display", "none");

			// Setup a more friendly text
			$(".esriSignInDialog").find(".dijitDialogPaneContentArea:first-child").find(":first-child").first().after("<div id='dijitDialogPaneContentAreaAtlasLoginText'>Please sign in with an account on <a href='http://" + esri.id._arcgisUrl + "' title='" + esri.id._arcgisUrl + "' target='_blank'>" + esri.id._arcgisUrl + "</a> to configure this application.</div>");
		}
		
		function prepareAppForWebmapReload()
		{
			dojo.publish("BUILDER_INCREMENT_COUNTER");
			
			if( dijit.byId("legend0") )
				dijit.byId("legend0").destroy();
			if( dijit.byId("legend1") )
				dijit.byId("legend1").destroy();
			
			$("#legendPanel").html('<div id="legend0"></div><div id="legend1"></div>');
			
			if( app.maps[0] ) {
				app.maps[0].destroy();
				app.maps[0] = null;
			}
			if( app.maps[1] ) {
				app.maps[1].destroy();
				app.maps[1] = null;
			}
			
			$("#header").css("display", "inherit");
			$("#footer").css("display", "inherit");
			$("#fatalError").css("display", "none");
			$("#loadingOverlay").css("top", "0px");
			
			loadingIndicator.start();
			loadingIndicator.setMessage(i18n.viewer.loading.step2);
			startLoadingTimeout();
			
			handleWindowResize();
		}
		
		function hideUI()
		{
			$("#header").hide();
			$(".mobileView").hide();
			$("#footer").hide();
			$(".modal").hide();
		}
		
		//
		// Mobile
		//

		function prepareMobileViewSwitch()
		{
			$(".mobileView").hide();
			$("#footerMobile").hide();
			$(".navBar span").removeClass("current");
		}

		function showMobileViewMap()
		{
			$("#contentPanel").show();
			$("#footerMobile").show();
			$("#mapPanel").show();
			
			handleWindowResize();
		}

		//
		// App init
		//
		
		function startLoadingTimeout()
		{
			// First view loading time before failure
			app.loadingTimeout = setTimeout(appLoadingTimeout, APPCFG.TIMEOUT_VIEWER_LOAD);
		}
		
		function cleanLoadingTimeout()
		{
			if (typeof app != "undefined" && app.loadingTimeout) {
				clearTimeout(app.loadingTimeout);
				app.loadingTimeout = null;
			}
		}
		
		function appLoadingTimeout()
		{
			// Restart the timeout if the dialog is shown or has been shown and the timeout hasn't been fired after it has been closed
			if( esri.id && esri.id.dialog && esri.id.dialog._alreadyInitialized && ! esri.id.loadingTimeoutAlreadyFired) {
				clearTimeout(app.loadingTimeout);
				startLoadingTimeout();
				// Set a flag only if the dialog isn't showned now, so next timeout will fail
				if( ! esri.id._busy ) 
					esri.id.loadingTimeoutAlreadyFired = true;
				return;
			}
			
			loadingIndicator.stop();
			loadingIndicator.setMessage(i18n.viewer.loading.fail + '<br /><button type="button" class="btn btn-medium btn-info" style="margin-top: 5px;" onclick="document.location.reload()">' + i18n.viewer.loading.failButton + '</button>', true);
			app.map && app.map.destroy();
		}
		
		function initLocalization()
		{
			dojo.query('#fatalError .error-title')[0].innerHTML = i18n.viewer.errors.boxTitle;
		}
		
		function isProd()
		{
			// Prevent the string from being replaced
			return CONFIG.environment != ['TPL','ENV','DEV'].join('_');
		}
		
		return {
			init: init,
			isProd: isProd,
			appInitComplete: appInitComplete,
			displayApp: displayApp,
			openInitPopup: openInitPopup,
			initError: initError
		};
	}
);
