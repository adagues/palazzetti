'use strict';
const Homey = require('homey');
const http = require('http');


const REGULATION_ENUM = {
	STOPPED: "STOPPED",
	WAITING_TEMP: "WAITING_TEMP",
	BURNING: "BURNING",
	STOPPED: "STOPPED",
	PAUSED: "PAUSED",
	SILENTLY: "SILENTLY"
}

const STOVE_STATE = {
	UNKNOW: 'UNKNOW',
	STOPPED:'STOPPED',
	STARTING:'STARTING',
	STARTED:'STARTED',
	STOPPING:'STOPPING',
	FAULTED:'FAULTED'
}

class CBoxDevice extends Homey.Device {
	smartStartEnbale = false;
	smartPauseEnable = false;
	tempSmartPause = 45;
	timeoutSmartPause = null;
	useExtCaptor = false;
	stoveIp = null;
	timeoutId;
	stoveState = STOVE_STATE.UNKNOW;
	regulationMode = REGULATION_ENUM.STOPPED;

	async onInit(){
		this.log('CBox Récupération des parametres...');
		const settings = this.getSettings();
		this.smartStartEnbale = settings.smartStart;
		this.smartPauseEnable = settings.smartPause;
		this.tempSmartPause = settings.pauseTemp;
		this.useExtCaptor = settings.externalTerm;
		this.stoveIp = settings.ip;

		this.log('CBox Initialisation...');
		this.regulationMode = await this.getCapabilityValue( 'stove_regulation' );
		//this.stoveStatus = null;
		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
		this.registerCapabilityListener('target_power', this.onCapabilityTargetPower.bind(this));
		this.registerCapabilityListener('target_fan_speed', this.onCapabilityTargetFanSpeed.bind(this));
		this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
		this.registerCapabilityListener('stove_regulation', this.onCapabilityRegulationMode.bind(this));
		//this.addCapability('locked');
		this.registerCapabilityListener('locked', this.onCapabilityLocked.bind(this));
		//await this.setCapabilityValue('stove_state', this.stoveState);

		//this.alarmePelletsChange = this.homey.flow.getDeviceTriggerCard('pellets_attention');
		//this.alarmePelletsChange.register();
		
		let notification = this.homey.notifications.createNotification({excerpt:"L'Application a bien démarrée"});
		this.timeoutId  = await this.registerIntervalRequest();
		this.homey.on('unload', () => clearInterval(this.timeoutId));
		this.log('Initialisation finalisée');
	}

	async registerIntervalRequest(){
		this.log('Enregistrement de la mise a jour réguliere');
		if( typeof this.stoveIp === 'undefined') return null;
		else if( this.timeoutId != null ){
			this.log('Suppression d une ancienne tache de maj');
			this.homey.clearInterval(this.timeoutId)
		}
		try{
			this.log('Test de la communication');
			await this.checkComm();
			await this.onTimeOut();
		}catch(error){
			this.log('Erreur de communication');
			return null;
		}
		this.log('Renvoie de la tache planifiée');
		return this.homey.setInterval(async() => {
			await this.onTimeOut();
		}, 60000);
	}

	async onSettings(settings){
		this.smartStartEnbale = settings.newSettings.smartStart;
		this.smartPauseEnable = settings.newSettings.smartPause;
		this.tempSmartPause = settings.newSettings.pauseTemp;
		this.useExtCaptor = settings.newSettings.externalTerm;
		
		if( settings.newSettings.deltaN1 >= settings.newSettings.deltaN2)
			throw new Error('Temp. N1 must be lower than Temp. N2');
		
		/*if( settings.newSettings.deltaN2 >= settings.newSettings.deltaSilence)
			throw new Error('Temp. N2 must be lower than Temp. Silence');*/
		if( settings.newSettings.deltaSilence >= settings.newSettings.deltaN1)
			throw new Error('Temp. Silence must be lower than Temp. N1');

		if( settings.oldSettings.ip != settings.newSettings.ip ){
			this.stoveIp = settings.newSettings.ip;
			try{
				await this.checkComm();
			}catch(error){
				throw new Error("ERROR_COMM_ERROR");
			}
			this.registerIntervalRequest();
		}
		
		if( this.useExtCaptor != settings.oldSettings.externalTerm){
			if( this.useExtCaptor){
				await this.setCapabilityValue('measure_temperature', await this.getCapabilityValue('external_temperature') );
			}else{
				await this.setCapabilityValue('measure_temperature', await this.getCapabilityValue('internal_temperature') );
			}
		}
		if( settings.oldSettings.externalTerm != settings.newSettings.externalTerm ||
			settings.oldSettings.pauseTemp != settings.newSettings.pauseTemp ){
				this.onTempChange();
		}else{
			this.applyTargetPresetForCurrentTemp();
		}

		

	}
	
	async checkComm(){
		let url = this.getcallCboxURL("LABL", false, null);
		await this.sendHTTPRequest(url);
	}
	
	async onTimeOut(){
		try{
			this.log("Mise a jour des états de la CBox");
			let url = this.getcallCboxURL("ALLS", false, null);
			let data = await this.sendHTTPRequest(url);
			this.stoveState = await this.updateStates(data.STATUS);
			await this.updateAllStates(data);
			this.checkStateAndRegulationMode();
			this.log("MAJ Terminée");
		}catch(error){
			this.log('Erreur de communication avec la CBox: ', error);
		}
	}
	
	async updateAllStates(data){
		await Promise.all([
			this.setStateOnOff(),
			this.setTargetTemperature(data.SETP),
			this.setPower(data.PWR),
			this.setFanSpeed(data.F2L),
			this.setInternalTemp(data.T1)
		]);
		return true;
	}
	
	/*------ MAJ CAPABILITIES -------------*/
	async updateStates(state ){
		
		let finalState = STOVE_STATE.UNKNOW;
		if( state == 0 )
			finalState = STOVE_STATE.STOPPED;
		else if( state >= 2 && state <= 5)
			finalState = STOVE_STATE.STARTING;
		else if( state == 6)
			finalState = STOVE_STATE.STARTED;
		else if( state >= 9 && state <= 12)
			finalState = STOVE_STATE.STOPPING;
		else if( state >= 241 && state <= 253)
			finalState = STOVE_STATE.FAULTED;
		this.log('etat final='+finalState);
		var promises = new Array();

		let oldStoveState = await this.getCapabilityValue('stove_state');
		if( oldStoveState != finalState ){
			promises.push( this.setCapabilityValue('stove_state', finalState) );
			let isBurning = (finalState == STOVE_STATE.STARTING) || (finalState == STOVE_STATE.STARTED);
			this.setInsightBurning(isBurning);
			
			let isOn = await this.getCapabilityValue( 'onoff' );
			if( isBurning && this.regulationMode != REGULATION_ENUM.BURNING && this.regulationMode != REGULATION_ENUM.SILENTLY ){
				this.regulationMode = REGULATION_ENUM.BURNING;
				this.setCapabilityValue('stove_regulation', this.regulationMode);
				if( !isOn ) this.setCapabilityValue('onoff', true);
			}else if( !isBurning && this.regulationMode != REGULATION_ENUM.STOPPED && this.regulationMode != REGULATION_ENUM.PAUSED && this.regulationMode != REGULATION_ENUM.WAITING_TEMP ){
				this.regulationMode = REGULATION_ENUM.STOPPED;
				this.setCapabilityValue('stove_regulation', this.regulationMode);
				if( isOn ) this.setCapabilityValue('onoff', false);
			}
		}
		
		let declenchementAlarmePellets = false;
		let oldStatePelletsAlarme = await this.getCapabilityValue('alarm_pellets');
		if( oldStatePelletsAlarme == null && state == 253 ){
			promises.push( this.setCapabilityValue('alarm_pellets', true) );
			declenchementAlarmePellets = true;
		}else if( oldStatePelletsAlarme == false && state == 253 ){
			promises.push( this.setCapabilityValue('alarm_pellets', true) );
			declenchementAlarmePellets = true;
		}else if( oldStatePelletsAlarme == true && state != 253 ){
			promises.push( this.setCapabilityValue('alarm_pellets', false) );
		}
		
		if( declenchementAlarmePellets ){
			this.alarmePelletsChange.trigger(this)
				.catch(this.error)
				.then(this.log("NO_MORE_PELLETS"));
		}
		
		
		await Promise.all(promises);
		return finalState;
	}

	async setStateOnOff(){
		let isOn = await this.getCapabilityValue( 'onoff' );
		let isOff = !isOn;
		let regulationMode = this.regulationMode;
		/* on ne change pas si les états connus sont cohérents*/
		if( isOff && STOVE_STATE.STOPPED == this.stoveState  && REGULATION_ENUM.STOPPED == regulationMode ){
			return true;
		}
		if( isOn && STOVE_STATE.STARTED == this.stoveState && REGULATION_ENUM.STOPPED != regulationMode ){
			return true;
		}
		/* On calcul les autres états*/
		/* seul cas a off si l'état est STOPPED et la regulation est STOPPED */
		if( STOVE_STATE.STOPPED == this.stoveState && REGULATION_ENUM.STOPPED == regulationMode){
			this.setCapabilityValue('onoff', false);
			return true;
		}else {
			this.setCapabilityValue('onoff', true);
		}
		return true;
	}
	async setCurrentTemp(temp){
		let oldTemp = await this.getCapabilityValue('measure_temperature');
		if( oldTemp == temp ) return true;
		
		this.log('Mise a jour de la temperature mesurée a '+ temp);
		await this.setCapabilityValue('measure_temperature', temp);
		await this.onTempChange();
		return true;
	}
	async setFanSpeed(fanSpeed){
		let state = await this.getCapabilityValue('target_fan_speed');
		let newSpeed = ""+fanSpeed;
		if( state != newSpeed ){
			this.log('Mise a jour de la ventilation a '+ fanSpeed);
			return await this.setCapabilityValue('target_fan_speed', newSpeed);
		}
		return true;
	}
	async setPower(power){
		let state = await this.getCapabilityValue('target_power');
		let newValue = ""+power;
		if( state != newValue ){
			this.log('Mise a jour de la puissance a '+ newValue);
			return await this.setCapabilityValue('target_power', newValue);
		}
		return true;	
	}
	async setTargetTemperature(targetTemperature){
		let knownTemp = await this.getCapabilityValue('target_temperature');
		if( knownTemp != targetTemperature ){
			this.log('Mise a jour de la température de consigne a '+ targetTemperature);
			return await this.setCapabilityValue('target_temperature', targetTemperature);
		}
		return true;
	}

	async setPreset(preset){
		let targetPreset = preset;
		this.log('Application du preset numero '+preset);
		const settings = this.getSettings();

		let targetPower = 1;
		let targetFanSpeed = 0;
		if( 3 != preset ){
			targetPower = settings['preset'+preset+'BurningPower'];
			targetFanSpeed = settings['preset'+preset+'FanSpeed'];
		}
		this.log('Preset '+targetPreset + " Puissance: "+targetPower + " Fan: "+targetFanSpeed);
		try{
			await this.applyPreset(targetPower,targetFanSpeed);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}

	async applyTargetPresetForCurrentTemp(){
		this.log('Selection du preset');
		const settings = this.getSettings();
		let temp = await this.getCapabilityValue('measure_temperature');
		let targetTemp = await this.getCapabilityValue('target_temperature');
		let currentDelta = temp - targetTemp;

		let deltaN1 = settings['deltaN1'];
		let deltaN2 = settings['deltaN2'];
		let deltaSilence = settings['deltaSilence'];
		let deltaSilenceEnabled = settings['deltaSilenceEnable'];

		let targetPreset = 0;

		if( (temp < targetTemp) && ((temp+1) >= targetTemp) ){
			targetPreset = 1;// on se laisse un petit delta pour eviter de sur consommer
		}else if(temp < targetTemp){// on est vriment trop loin de la temp de consigne
			targetPreset = 0;//after that currentDelta is >= 0
		}else if(currentDelta >= deltaN1 && currentDelta < deltaN2 ){
			targetPreset = 1;
		}else if(currentDelta >= deltaN2 && currentDelta < deltaSilence ){
			targetPreset = 2;
		}else if(currentDelta >= deltaSilence ){
			targetPreset = 3;
			if( !deltaSilenceEnabled )
				targetPreset = 2;
		}else{
			targetPreset = 0;
		}

		this.setPreset(targetPreset);


	}

	async isRegulationMode(mode){
		return await this.getCapabilityValue('stove_regulation') == mode;
	}

	async setExternalTemp(temp){
		let oldTemp = await this.getCapabilityValue('external_temperature');
		if( oldTemp == temp ) return true;
		this.log('TEMPERATURE EXTERNE'+temp);
		await this.setCapabilityValue('external_temperature', temp);

		if( this.useExtCaptor ){

			await this.setCurrentTemp(temp);
		}
	}

	async setInternalTemp(temp){
		let oldTemp = await this.getCapabilityValue('internal_temperature');
		if( oldTemp == temp ) return true;
		await this.setCapabilityValue('internal_temperature', temp);
		if( !this.useExtCaptor ){
			await this.setCurrentTemp(temp);
		}
	}

	async onTempChange(){
		this.log('Sur Changement de température');
		let regulationMode = this.regulationMode;
		this.log("Mode de regulation acctuel="+regulationMode);
		if( REGULATION_ENUM.WAITING_TEMP == regulationMode || REGULATION_ENUM.PAUSED == regulationMode ){
			let canStartWithSSsettings = await this.isCanStartWSStartKnonwTemp();
			if( canStartWithSSsettings ){
				await this.applyTargetPresetForCurrentTemp();
				await this.setOnOffPoele(true);
				this.regulationMode = REGULATION_ENUM.BURNING;
				this.setCapabilityValue('stove_regulation', this.regulationMode);
			}
			this.log('Peut redémarrer='+canStartWithSSsettings);
		}else if(REGULATION_ENUM.BURNING == regulationMode || REGULATION_ENUM.SILENTLY == regulationMode ){
			let canPaused = await this.isCanPauseWKnonwTemp();
			if( canPaused ){
				await this.setOnOffPoele(false);
				this.regulationMode = REGULATION_ENUM.PAUSED;
				this.setCapabilityValue('stove_regulation', this.regulationMode);
			}else if( REGULATION_ENUM.BURNING == regulationMode ){
				this.applyTargetPresetForCurrentTemp();
			}
		}
	}

	async setSmartPause(isActive){
		await this.setSettings({
			smartPause: isActive,
		});
		this.smartPauseEnable = isActive;
		return true;
	}

	async isCanStartWSStartKnonwTemp(){
		let startLocked = await this.getCapabilityValue('locked');
		if( true == startLocked ){
			this.log('Demarrage bloqué');	
			return false;
		}
		let stoveState = await this.getCapabilityValue('stove_state');
		
		if( stoveState != STOVE_STATE.STOPPED )
			return false;
		
		let regulationMode = this.regulationMode;

		if( !this.smartStartEnbale && regulationMode != REGULATION_ENUM.PAUSED )
			return true;

		let mesuredTemp = await this.getCapabilityValue('measure_temperature');
		let targetTemp = await this.getCapabilityValue('target_temperature');
		
		const settings = this.getSettings();
		let deltaReprisePause = settings.restartPauseTemp;
		this.log('On verifie si le redemarrage est possible');
		if( null == mesuredTemp ) return false;
		if( regulationMode == REGULATION_ENUM.WAITING_TEMP && mesuredTemp <= targetTemp )
			return true;
		if( regulationMode == REGULATION_ENUM.PAUSED && mesuredTemp <= (targetTemp+deltaReprisePause) )
			return true;

		return false;
	}

	async isCanPauseWKnonwTemp(){
		this.log('Etat du smat Pause = '+this.smartPauseEnable);
		if( !this.smartPauseEnable ) return false;
		let stoveState = await this.getCapabilityValue('stove_state');
		if( stoveState != STOVE_STATE.STARTED ) return false;

		let mesured = await this.getCapabilityValue('measure_temperature');
		if( null == mesured ) return false;
		let targetTemp = await this.getCapabilityValue('target_temperature');
		if( mesured >= (this.tempSmartPause+targetTemp) ) return true;

		return false;
	}

	async isSmartStartEnabled(){
		return this.smartStartEnbale;
	}

	/*------ CAPABILITIES LISTENER ----------*/
	async onCapabilityOnOff(value, opts){
		let url = null;
		let currentStoveState = await this.getCapabilityValue('stove_state');
		if( this.stoveState == STOVE_STATE.STOPPED && value == true ){
			/*NOTHING*/
		}else if( this.stoveState == STOVE_STATE.STARTED && value == false ){
			/* NOTHING */
		}else if( this.stoveState == STOVE_STATE.STOPPED && value == false ){
			this.regulationMode = STOVE_STATE.STOPPED;
			await this.setCapabilityValue('stove_regulation', this.regulationMode);
			return true;
		}else if( this.stoveState == STOVE_STATE.STOPPING && value == false ){
			this.regulationMode = STOVE_STATE.STOPPED;
			await this.setCapabilityValue('stove_regulation', this.regulationMode);
			return true;
		}else{
			throw new Error(this.homey.__('illegalStateOnOff'));
		}
		try{
			let startLocked = await this.getCapabilityValue('locked');
			if(value && startLocked ){
				throw new Error(this.homey.__('illegalStateOnOff'));
			}else if( value ){
				this.regulationMode = REGULATION_ENUM.WAITING_TEMP;
				await this.setCapabilityValue('stove_regulation', this.regulationMode);
				if( await this.isCanStartWSStartKnonwTemp() ){/* demande de demarrage*/
					await this.setOnOffPoele(true);
					this.regulationMode = REGULATION_ENUM.BURNING;
					await this.setCapabilityValue('stove_regulation', this.regulationMode);
				}
			}else {
				await this.setOnOffPoele(false);
				this.regulationMode = REGULATION_ENUM.STOPPED;
				await this.setCapabilityValue('stove_regulation', this.regulationMode);
			}
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}
	
	async setInsightBurning(isBurning){
		let insightLogger;
		this.log('Changement etat insight burning:'+isBurning);
		try{
			insightLogger = await this.homey.insights.getLog('stove_state');
		}catch(e){
			this.log('Creation insight burning');
			insightLogger = await this.homey.insights.createLog('stove_state',{
				title: { en: "Burning",fr:"Allumé" },
          		type: 'boolean',
          		units: { en: 'Value' },
        		decimals: 0,
        		chart: 'column'
			});
		}
		try {
			await insightLogger.createEntry(isBurning);
			this.log('Enregistrement etat insight burning:'+isBurning);
		} catch(err) {
			this.log('Erreur etat insight burning:'+isBurning);
			console.log(err);
		}
	}

	async onCapabilityTargetTemperature(value, opts){
		let url = this.getcallCboxURL("SETP", true, value);
		try{
			await this.sendHTTPRequest(url);
			this.setCapabilityValue('target_temperature', value);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}
	
	async onCapabilityTargetPower(value, opts){
		let url = this.getcallCboxURL("POWR", true, value);
		try{
			await this.sendHTTPRequest(url);
			this.setCapabilityValue('target_power', value);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
		return true;
	}
	
	async onCapabilityTargetFanSpeed(value, opts){
		let url = this.getcallCboxURL("RFAN", true, value);
		try{
			await this.sendHTTPRequest(url);
			this.setCapabilityValue('target_fan_speed', value);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}

	async onCapabilityRegulationMode(value, opts){
		let isOn = await this.getCapabilityValue('onoff');
		let stoveState = await this.getCapabilityValue('stove_state');
		let startLocked = await this.getCapabilityValue('locked');

		//if( !isOn && value == "STOPPED" ) throw new Error(this.homey.__('illegalRegulationMode'));
		if( isOn && value == REGULATION_ENUM.STOPPED && (stoveState == STOVE_STATE.STOPPED || stoveState == STOVE_STATE.STOPPING) ){
			this.regulationMode = value;
			this.setCapabilityValue('stove_regulation', value);
			this.setCapabilityValue('onoff', false);
			return;
		}else if( value == REGULATION_ENUM.STOPPED ){
			throw new Error(this.homey.__('manualActionImpossible'));
		}
		if( value == REGULATION_ENUM.WAITING_TEMP ) throw new Error(this.homey.__('manualActionImpossible'));
		if( !isOn ){
			throw new Error(this.homey.__('illegalRegulationMode'));
		}
		/* A CE POINT LE POELE EST FORCEMENT ALLUME */
		if( value == REGULATION_ENUM.SILENTLY && (stoveState == STOVE_STATE.STARTED || stoveState == STOVE_STATE.STARTING) ){
			try{
				this.log('Passage en mode silenece');
				await this.applyPreset(1,0);
			}catch( error ){
				throw new Error("ERROR_COMM_ERROR");
			}
		}else if( value == REGULATION_ENUM.PAUSED && stoveState == STOVE_STATE.STARTED ){
			await this.setOnOffPoele(false);
		}else if( value == REGULATION_ENUM.BURNING && stoveState == STOVE_STATE.STOPPED && !startLocked){
			await this.setOnOffPoele(true);
		}else if( value == REGULATION_ENUM.BURNING && (stoveState == STOVE_STATE.STARTED || stoveState == STOVE_STATE.STARTING) ){
			/*NOTHING HERE */
		}else {
			throw new Error(this.homey.__('manualActionImpossible'));
		}
		/* ON MET A JOUR L'ETAT*/
		this.regulationMode = value;
		this.setCapabilityValue('stove_regulation', value);
	}

	async onCapabilityLocked(value, opts){
		this.setCapabilityValue('locked', value);
	}
	
	/*---------- COMMUNICATION AVEC LA CBOX --------*/
	getOnOffRequestURL(isGotoOn) {
		if( null == this.stoveIp ) throw Error('ERROR_NO_IP');;
		let url = "http://"+this.stoveIp+"/cgi-bin/sendmsg.lua?cmd=CMD+";
		if( isGotoOn ){
			url += "ON";
		}else{
			url += "OFF";
		}
		return url;
	}
	
	getcallCboxURL(command, isSet, value) {
		
		if( null == this.stoveIp ) throw Error('ERROR_NO_IP');
		let url = "http://"+this.stoveIp+"/cgi-bin/sendmsg.lua?cmd=";
		if( isSet ){
			url += "SET+"+command+"+"+value;
		}else{
			url += "GET+"+command;
		}
		return url;
	}

	async setOnOffPoele(setOn){
		let url = this.getOnOffRequestURL(setOn);
		try{
			await this.sendHTTPRequest(url);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
	}
	
	async applyPreset(power, fanSpeed){
		this.log('Application preset: Power:'+power+' Fan:'+fanSpeed);
		let urlForFan = this.getcallCboxURL("RFAN", true, fanSpeed);
		let urlForPower = this.getcallCboxURL("POWR", true, power);
		this.log('ENVOIE FAN');
		await this.sendHTTPRequest(urlForFan);
		this.log('ENVOI POWER');
		await this.sendHTTPRequest(urlForPower);
		this.log('SAUVEGARDE ETAT');
		this.setCapabilityValue('target_fan_speed', ""+fanSpeed);
		this.setCapabilityValue('target_power', ""+power);

		return true;
	}
	
	sendHTTPRequest(url){
		return new Promise( (resolve, reject)=>{
			var myRequest = http.get(url, resp =>{
				let data = '';
				resp.on('data', (chunk) => {
					data += chunk;
				});
				resp.on('end', () => {
					try{
						let jsonData = JSON.parse(data);
						if( jsonData.SUCCESS )
							resolve(jsonData.DATA);
						else
							reject(new Error('Failed'));
					}catch(error){
						reject(error);
					}
				});
			});
			myRequest.on("error", function(err){
				reject(err);
			});
			myRequest.setTimeout(5000);
			myRequest.end();
		});
	}
}

module.exports = CBoxDevice;