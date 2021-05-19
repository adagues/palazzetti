const Homey = require('homey');
const crypto = require("crypto");

class CboxDriver extends Homey.Driver {
	async onPairListDevices() {
		return [{
			name: 'CBox',
			data: { id: '1' }
		}];
	}

	async onPair(session){
		let uuid = crypto.randomBytes(16).toString("hex");;
		const devices = [{
			  name: "CBox",
	  
			  data: {
				id: uuid,
			  }
		}];
		session.setHandler("list_devices", async function () {
			return devices;
		});
	}
	
	onInit(){
		this.homey.flow.getActionCard('setTargetPower')
			.registerRunListener(async (args, state)=> {
				try{
					this.log("Changement de la puissance");
					return args.device.onCapabilityTargetPower(args.target_power, null);
				}catch(error){
					this.log(error);	
				}
		});
		this.homey.flow.getActionCard('setTargetFanSpeed')
			.registerRunListener(async (args, state)=> {
				try{
					this.log("Changement de la vitesse des ventilateurs");
					return args.device.onCapabilityTargetFanSpeed(args.target_fan_speed, null);
				}catch(error){
					this.log(error);	
				}
		});
		this.homey.flow.getActionCard('setPreset')
			.registerRunListener(async (args, state)=> {
				try{
					this.log("Application d'un préréglage");
					return args.device.setPreset(args.preset);
				}catch(error){
					this.log(error);	
				}
		});
		this.homey.flow.getActionCard('setRegulationInState')
			.registerRunListener(async (args, state)=> {
				try{
					this.log("Application d'un mode de régulation");
					return args.device.onCapabilityRegulationMode(args.state, null);
				}catch(error){
					this.log(error);	
				}
		});
		this.homey.flow.getActionCard('setExternalTemp')
		.registerRunListener(async (args, state)=> {
			try{
				this.log("Application d'une temperature externe");
				return args.device.setExternalTemp(args.temperature);
			}catch(error){
				this.log(error);	
			}
		});
		this.homey.flow.getActionCard('setSmartPause')
		.registerRunListener(async (args, state)=> {
			try{
				this.log("changement du smartPause");
				return await args.device.setSmartPause(args.smartPause == 1);
			}catch(error){
				this.log(error);	
			}
		});
		this.homey.flow.getConditionCard('isRegulationInState')
			.registerRunListener(async (args, state)=> {
				try{
					this.log("Demande du mode de regulation");
					return await args.device.isRegulationMode(args.state);
				}catch(error){
					this.log(error);	
				}
		});
		this.homey.flow.getConditionCard('isSmartStartEnabled')
			.registerRunListener(async (args, state)=> {
				try{
					this.log("Demande si Smart Start Actif:");
					return await args.device.isSmartStartEnabled();
				}catch(error){
					this.log(error);	
				}
		});
	}
}

module.exports = CboxDriver;