'use strict';
const Homey = require('homey');
const http = require('http');


class CBoxDevice extends Homey.Device {
	smartStartEnbale = false;
	smartPauseEnable = false;
	tempSmartPause = 45;
	durationSmartPause = 0;
	timeoutSmartPause = null;
	useExtCaptor = false;
	stoveIp = null;
	timeoutId;

	async onInit(){
		this.log('CBox Récupération des parametres...');
		const settings = this.getSettings();
		this.smartStartEnbale = settings.smartStart;
		this.smartPauseEnable = settings.smartPause;
		this.tempSmartPause = settings.pauseTemp;
		this.durationSmartPause = settings.tempDuration;
		this.useExtCaptor = settings.externalTerm;
		this.stoveIp = settings.ip;

		this.log('CBox Initialisation...');
		this.stoveState = 'UNKNOW';
		//this.stoveStatus = null;
		this.registerCapabilityListener('target_temperature', this.onCapabilityTargetTemperature.bind(this));
		this.registerCapabilityListener('target_power', this.onCapabilityTargetPower.bind(this));
		this.registerCapabilityListener('target_fan_speed', this.onCapabilityTargetFanSpeed.bind(this));
		this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
		this.registerCapabilityListener('stove_regulation', this.onCapabilityRegulationMode.bind(this));
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
		this.durationSmartPause = settings.newSettings.tempDuration;
		this.useExtCaptor = settings.newSettings.externalTerm;
		
				
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
		
		let finalState = 'UNKNOW';
		if( state == 0 )
			finalState = 'STOPPED';
		else if( state >= 2 && state <= 5)
			finalState = 'STARTING';
		else if( state == 6)
			finalState = 'STARTED';
		else if( state >= 9 && state <= 12)
			finalState = 'STOPPING';
		else if( state >= 241 && state <= 253)
			finalState = 'FAULTED';
			
		var promises = new Array();

		let oldStoveState = await this.getCapabilityValue('stove_state');
		if( oldStoveState != finalState )
			promises.push( this.setCapabilityValue('stove_state', finalState) );
		
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
		let regulationMode = await this.getCapabilityValue( 'stove_regulation' );
		/* on ne change pas si les états connus sont cohérents*/
		if( isOff && "STOPPED" == this.stoveState  && "STOPPED" == regulationMode ){
			return true;
		}
		if( isOn && "STARTED" == this.stoveState && "STOPPED" != regulationMode ){
			return true;
		}
		/* On calcul les autres états*/
		/* seul cas a off si l'état est STOPPED et la regulation est STOPPED */
		if( "STOPPED" == this.stoveState && "STOPPED" == regulationMode){
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
		let targetPower = settings['preset'+preset+'BurningPower'];
		let targetFanSpeed = settings['preset'+preset+'FanSpeed'];
		this.log('Preset '+targetPreset + "Puissance: "+targetPower + " Fan: "+targetFanSpeed);
		try{
			await this.applyPreset(targetPower,targetFanSpeed);
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
		}
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
	let regulationMode = await this.getCapabilityValue('stove_regulation');
	if( "WAITING_TEMP" == regulationMode || "PAUSED" == regulationMode ){
		let canStartWithSSsettings = await this.isCanStartWSStartKnonwTemp();
		if( canStartWithSSsettings ){
			await this.setOnOffPoele(true);
			this.setCapabilityValue('stove_regulation', "BURNING");
		}
	}else if("BURNING" == regulationMode || "SILENTLY"==regulationMode ){
		let canPaused = await this.isCanPauseWKnonwTemp();
		if( canPaused ){
			await this.setOnOffPoele(false);
			this.setCapabilityValue('stove_regulation', "PAUSED");
		}
	}
}

	async setSmartPause(isActive){
		await this.setSettings({
			smartPause: isActive,
		});
		return true;
	}

	async isCanStartWSStartKnonwTemp(){

		let stoveState = await this.getCapabilityValue('stove_state');
		if( stoveState != 'STOPPED') return false;

		let regulationMode = await this.getCapabilityValue('stove_regulation');

		if( !this.smartStartEnbale && regulationMode != "PAUSED" ) return true;

		let mesuredTemp = await this.getCapabilityValue('measure_temperature');
		let targetTemp = await this.getCapabilityValue('target_temperature');
		if( null == mesuredTemp ) return false;

		if( mesuredTemp < targetTemp ) return true;

		return false;
	}

	async isCanPauseWKnonwTemp(){
		if( !this.smartPauseEnable ) return false;
		let stoveState = await this.getCapabilityValue('stove_state');
		if( stoveState != 'STARTED') return false;

		let mesured = await this.getCapabilityValue('measure_temperature');
		if( null == mesured ) return false;
		let targetTemp = this.tempSmartPause;
		if( mesured >= targetTemp ) return true;

		return false;
	}

	async isSmartStartEnabled(){
		return this.smartStartEnbale;
	}

	/*------ CAPABILITIES LISTENER ----------*/
	async onCapabilityOnOff(value, opts){
		let url = null;
		if( this.stoveState == 'STOPPED' && value == true ){
			/*NOTHING*/
		}else if( this.stoveState == 'STARTED' && value == false ){
			/* NOTHING */
		}else if( this.stoveState == 'STOPPED' && value == false ){
			await this.setCapabilityValue('stove_regulation', "STOPPED");
			return true;
		}else{
			throw new Error(this.homey.__('illegalStateOnOff'));
		}
		try{
			if( value && !await this.isCanStartWSStartKnonwTemp() ){/* demande de demarrage*/
				this.setCapabilityValue('stove_regulation', "WAITING_TEMP");
			}else if( value ) {
				await this.setOnOffPoele(true);
				this.setCapabilityValue('stove_regulation', "BURNING");
			}else {
				await this.setOnOffPoele(false);
				this.setCapabilityValue('stove_regulation', "STOPPED");
			}
		}catch( error ){
			throw new Error("ERROR_COMM_ERROR");
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
		let currentRegulationMode = await this.getCapabilityValue('stove_regulation');

		//if( !isOn && value == "STOPPED" ) throw new Error(this.homey.__('illegalRegulationMode'));
		if( isOn && value == "STOPPED" && (stoveState == "STOPPED" || stoveState == "STOPPING") ){
			this.setCapabilityValue('stove_regulation', value);
			this.setCapabilityValue('onoff', false);
		}else if( value == "STOPPED" ){
			throw new Error(this.homey.__('manualActionImpossible'));
		}
		if( value == "WAITING_TEMP" ) throw new Error(this.homey.__('manualActionImpossible'));
		if( !isOn ) throw new Error(this.homey.__('illegalRegulationMode'));
		/* A CE POINT LE POELE EST FORCEMENT ALLUME */
		if( value == "SILENTLY" && (stoveState == 'STARTED' || stoveState == 'STARTING') ){
			try{
				this.log('Passage en mode silenece');
				await this.applyPreset(1,0);
				this.setCapabilityValue('stove_regulation', value);
			}catch( error ){
				throw new Error("ERROR_COMM_ERROR");
			}
		}else if( value == "PAUSED" && stoveState == 'STARTED' ){
			await this.setOnOffPoele(false);
			this.setCapabilityValue('stove_regulation', value);
		}else if( value == "BURNING" && stoveState == 'STOPPED'){
			await this.setOnOffPoele(true);
			this.setCapabilityValue('stove_regulation', value);
		}else if( value == "BURNING" && (stoveState == 'STARTED' || stoveState == 'STARTING') ){
			this.setCapabilityValue('stove_regulation', value);
		}else {
			throw new Error(this.homey.__('manualActionImpossible'));
		}
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