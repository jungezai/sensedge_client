var os = require('os');
var noble = require('noble');
var nodemailer = require('nodemailer');
var ip = require('ip');
var mqsh = require('./mqpubsub.js');

const RH_THRESHOLD = 80

const u1_carrier = 'AT&T';
const u1_number = '1234567';
const u2_carrier = 'Verizon';
const u2_number = '1234567';
const u3_carrier = 'T-Mobile';
const u3_number = '1234567';

const phoneBook = {
	'Yi':		{ 'carrier': 'T-Mobile', 'number': '4083178351' },
	'Li':		{ 'carrier': 'Verizon',  'number': '2082720078' },
	'George':	{ 'carrier': 'Verizon',  'number': '5105661442' },
	'1':		{ 'carrier': u1_carrier, 'number': u1_number    },
	'2':		{ 'carrier': u2_carrier, 'number': u2_number    },
	'3':		{ 'carrier': u3_carrier, 'number': u3_number    },
};
const monitorTable = {
	'c2:45:ad:66:f2:d8' : [ phoneBook['Li'], phoneBook['1'], phoneBook['2'], phoneBook['3'] ],
	'e5:10:e1:a8:c4:1d' : [ phoneBook['Li'], phoneBook['1'], phoneBook['2'], phoneBook['3'] ],
	'f2:1c:0d:2b:1d:0c' : [ phoneBook['Li'], phoneBook['1'], phoneBook['2'], phoneBook['3'] ],
	'c8:54:2b:02:8b:e2' : [ phoneBook['Li'], phoneBook['1'], phoneBook['2'], phoneBook['3'] ],
	'c4:34:39:d3:1d:6e' : [ phoneBook['Li'], phoneBook['1'], phoneBook['2'], phoneBook['3'] ],
	'cf:1e:ad:95:5a:1a' : [ phoneBook['Li'], phoneBook['1'], phoneBook['2'], phoneBook['3'] ],
};

// Detection Algorithm
const ALGO_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const ALGO_TEMPRAMP_MS = 2 * 60 * 1000; // 2 minutes
const ALGO_TEMPRAMP_VALUE = 0.5; // 0.5 Celsius

var gConfig = { 'bootNotification':
			{ 'enable': false, 'os': 'linux', 'uptime': 60, 'recipient': phoneBook['Li'] },
		'cloudUpdate': true,
		'useAlgorithm': false,
};
var gDevices = {};
var gResetting = false;
var gState;

function Device(peripheral) {
	this.peripheral		= peripheral;
	this.temperature	= 0;
	this.humidity		= 0;
	this.rssi		= peripheral.rssi;
	this.enabled		= false;
	this.notified		= false;
	this.connecting		= false;
	this.tsconn		= (new Date()).getTime();
	this.symbol		= 'U';
	// detection algorithm related
	this.state		= 'STATE_INIT';
	this.rh_start		= 0;
	this.records		= [];
}

function doNotification(dev) {
	if (gConfig['useAlgorithm']) {
		algo_detection(dev);
	} else {
		if (dev['humidity'] >= RH_THRESHOLD) {
			if (!dev['notified']) {
				dev['notified'] = true;
				sendNotification(dev);
			}
		} else {
			dev['notified'] = false;
		}
	}
}

function processSensorData(type, addr, data) {
	// Send boot notification on Raspberry Pi
	var bn = gConfig['bootNotification'];
	if (bn['enable'] && os.platform() == bn['os'] && os.uptime() < bn['uptime']) {
		// Notify only once
		bn['enable'] = false;
		SendSMS(bn['recipient'], 'host ' + os.hostname() + ' booted',
			'Date: ' + new Date() + '\nUptime: ' + os.uptime() +
			's\nIP: ' + ip.address() + '\nSensor: ' + addr,
			function(error) {
				if (error) {
					console.log('\tSend Boot SMS failed: ' + error);
				} else {
					console.log('\tSend Boot SMS successfully');
				}
		});
	}
	var dev = gDevices[addr];
	if (type == 'CFX') {
		// data format: flag (1) temperature (4, IEEE 11073 float LE) timestamp (7) type (1)
		//console.log('buf ' + data.toString('hex'));
		var vtype = data.readUInt8(0) & 0x1;
		var man = data.readIntLE(1, 3);
		var exp = data.readInt8(4);
		var value = (man * Math.pow(10, exp)).toFixed(2);
		if (vtype == 0)
			dev['temperature'] = value;
		else
			dev['humidity'] = value;
	} else {
		var len = data.readUInt8(0);
		var flag = data.readUInt8(1);
		var checksum = data.readUInt8(len);
		var cs = 0;
		for (var i = 0; i < len; i++) {
			cs ^= data.readUInt8(i);
		}
		if (cs != checksum) {
			console.log('\tInvalid checksum ' + cs + ' for frame ' + data.toString('hex'));
			return;
		}
		switch (flag) {
		case 1:
			var temperature = (data.readInt16BE(2) / 10.0).toFixed(1);
			var humidity = (data.readInt16BE(4) / 10.0).toFixed(1);
			dev['temperature'] = temperature;
			dev['humidity'] = humidity;
			break;
		case 2:
			var unused_value = data.readInt8(2);
			return;
		}
	}
	if (gConfig['cloudUpdate']) {
		pushAWS(addr, dev['temperature'], dev['humidity'], function(shadow, error) {
		var str = 'cloudUpdate ';
		if (error)
			str += 'failed';
		else
			str += 'success';

		// Ignore shadow result
		if (shadow)
			return;

		console.log('\t' + dev['symbol'], addr + ' RSSI:' + dev['rssi'], 'temperature',
			    dev['temperature'], 'C humidity', dev['humidity'], '%', str);
		});
	} else {
		console.log('\t' + dev['symbol'], addr + ' RSSI:' + dev['rssi'], 'temperature',
			    dev['temperature'], 'C humidity', dev['humidity'], '%');
	}
	doNotification(dev);
}

function sendNotification(dev) {
	// Send notification
	var addr = dev['peripheral'].address;
	var subject = addr + ' needs your attention';
	var body = 'Humidity: ' + dev['humidity'] + ' %\nTemperature: ' +
		dev['temperature'] + ' \u00B0C\n';

	for (var i in monitorTable[addr]) {
		var phoneInfo = monitorTable[addr][i];
		SendSMS(phoneInfo, subject, body, function(error) {
			if (error) {
				console.log('\t\tSend SMS to ' + this.number +
					' failed: ' + error);
			} else {
				console.log('\t\tSend SMS to ' + this.number +
					' successfully');
			}
		}.bind( {number:phoneInfo['number']} ));
	}
}

function algo_detection(dev) {
	var now = new Date();
	if (dev['state'] == 'STATE_INIT') {
		if (dev['humidity'] >= RH_THRESHOLD) {
			dev['rh_start'] = now;
			dev['state'] = 'STATE_HUMIDITY_DETECTED';
		}
	} else if (dev['state'] == 'STATE_HUMIDITY_DETECTED') {
		if (now.getTime() > new Date(dev['rh_start'].getTime() + ALGO_COOLDOWN_MS).getTime()) {
			dev['records'] = [];
			dev['state'] = 'STATE_TEMP_DETECTING';
		}
	} else if (dev['state'] == 'STATE_TEMP_DETECTING') {
		for (var i in dev['records']) {
			// keep only 1 minutes records
			if (now.getTime() > new Date(dev['records'][i]['timestamp'].getTime() + ALGO_TEMPRAMP_MS).getTime())
				dev['records'].splice(i, 1);
			else
				break;
		}
		var min = Math.min.apply(Math, dev['records'].map(function(r) {
				return r.temperature;
		}));
		if (dev['temperature'] <= min + ALGO_TEMPRAMP_VALUE) {
			dev['records'].push({'timestamp': now,
					     'temperature': dev['temperature'],
					     'humidity': dev['humidity']});
			return;
		}
		// Detected
		if (dev['notified'])
			return;

		// Send notification
		sendNotification(dev);

		dev['state'] = 'STATE_INIT';
		dev['notified'] = false;
		dev['records'] = [];
	}
}

function disconnect(callback) {
	for (addr in gDevices) {
		gDevices[addr]['enabled'] = false;
		gDevices[addr]['peripheral'].disconnect(function() {
			console.log('Disconnected from peripheral: ' + addr + ' (RSSI: ' + gDevices[addr]['rssi'] + ') on ' + new Date());
		});
	}
	setTimeout(callback, 1000);
}

function execCmd(line, callback)
{
	var execFile = require('child_process').execFile;
	var l = line.trim();
	var cmd = l;
	var args = '';
	var space = l.indexOf(' ');
	if (space > 0) {
		cmd = l.substr(0, space);
		args = l.substr(space + 1);
	}
	switch(cmd) {
	case 'exit':
		process.exit(0);
	default:
		//console.log('> ' + cmd, args);
		var arglist = undefined;
		if (args != '') {
			arglist = args.split(' ');
		}
		execFile(cmd, arglist, function(error, stdout, stderr) {
			var output;
			if (error) {
				callback(error, stderr);
				output = error + stderr;
			} else {
				callback(error, stdout);
				output = stdout;
			}
			mqsh.output_pub(os.hostname(), output, function(){});
		});
		break;
	}
}

function bleScan()
{
	if (gState === 'poweredOn' && !gResetting)
		noble.startScanning();
}

function hciReset()
{
	var exec = require('child_process').exec;

	gResetting = true;
	exec('hciconfig hci0 reset', function callback(error, stdout, stderr){
		// result
		//console.log("hci0 reset", error ? "fail" : "success");
		gResetting = false;
	});
}

function pushAWS(addr, vt, vh, callback) {
	var util = require('util');
	var spawn = require('child_process').spawn;
	var execFile = require('child_process').execFile;
	var mosqparam = [
		'--cafile', 'certs/rootCA.pem',
		'--cert', 'certs/keys/certificate.pem',
		'--key', 'certs/keys/private.key',
		'-h', 'a7dsuf6iddqdg.iot.us-west-2.amazonaws.com',
		'-p', '8883'
	];
	var logDate = new Date();
	var postData = {
		datetime: logDate.toISOString(),
		temperature: parseFloat(vt),
		humidity: parseFloat(vh)
	};
	console.log("pushAWS", postData);
	// publish to main data queue (for DynamoDB)
	execFile('mosquitto_pub', mosqparam.concat('-t', 'temp-humidity/Sensor-' + addr, '-m', JSON.stringify(postData)),
		 function(error, stdout, stderr) {
			// published
			callback(false, error);
	});
	// publish to device shadow
	var shadowPayload = {
		state: {
			desired: {
				datetime: logDate.toISOString(),
				temperature: parseFloat(vt),
				humidity: parseFloat(vh)
			}
		}
	};
	execFile('mosquitto_pub', mosqparam.concat('-t','$aws/things/Sensor-' + addr + '/shadow/update', '-m',
		 JSON.stringify(shadowPayload)), function(error, stdout, stderr) {
			// shadow update done
			callback(true, error);
	});
}

// pushAWS and detection algorithm simulation
function simulate() {
	var addr = 'Sim';
	var simDevice = new Device({'address': addr, 'rssi': 0});
	console.log('Start Simulation...');
	setInterval(function() {
		var temp = (Math.random() * (40 - 25) + 25).toFixed(2);
		var humidity = (Math.random() * (100 - 30) + 30).toFixed(2);
		pushAWS(addr, temp, humidity, function(shadow, error) {
			if (error)
				console.log("AWS push error,", error, "shadow:", shadow);
		});
		simDevice['temperature'] = temp;
		simDevice['humidity'] = humidity;
		doNotification(simDevice);
	}, 5000);
}

noble.on('stateChange', function(state) {
	gState = state;
	if (state === 'poweredOn') {
		noble.startScanning();
	} else {
		noble.stopScanning();
	}
});

noble.on('discover', function(peripheral) {
	if (peripheral.advertisement.localName == "CFX_DIAPER" || peripheral.advertisement.localName == "XuXuKou") {
		var addr = peripheral.address;
		var now = (new Date()).getTime();

		// Avoid duplicated connection, parallel connection and if we haven't heard a sensor
		// for 20s, we will reconnect with it (when adv is heard).
		if (gDevices[addr] && (now - gDevices[addr]['tsconn'] < 20 * 1000) &&
		    (gDevices[addr]['enabled'] == true || gDevices[addr]['connecting'] == true)) {
			//console.log("Quit connection: addr ", addr, "enable", gDevices[addr]['enabled'],
			//	    "connecting", gDevices[addr]['connecting'], "tsdiff", now - gDevices[addr]['tsconn']);
			hciReset();
			return;
		}
		if (!gDevices[addr])
			gDevices[addr] = new Device(peripheral);
		gDevices[addr]['connecting'] = true;
		gDevices[addr]['tsconn'] = now;

		// start connection
		peripheral.connect(function(error) {
			console.log('Connected to ' + peripheral.address + ' (RSSI ' + peripheral.rssi + ') on ' + new Date());
			peripheral.discoverServices(['1809', '6e400001b5a3f393e0a9e50e24dcca9e'], function(error, services) {
				var deviceInformationService = services[0];
				console.log("Discovered Health Thermometer GATT Service");
				deviceInformationService.discoverCharacteristics(['2a1c', '6e400003b5a3f393e0a9e50e24dcca9e'], function(error, characteristics) {
					var temperatureMeasurementCharacteristic = characteristics[0];
					console.log('Discovered Temperature Measurement Service');
					// enable notify
					temperatureMeasurementCharacteristic.notify(true, function(error) {
						console.log('Temperature Measurement Notification On');
						gDevices[addr]['enabled'] = true;
						gDevices[addr]['connecting'] = false;
						gDevices[addr]['tsconn'] = now;
					});
					// subscribe indicate
					temperatureMeasurementCharacteristic.subscribe(function(error) {
						temperatureMeasurementCharacteristic.on('data', function(data, isNotification) {
							var type;
							switch (temperatureMeasurementCharacteristic.uuid) {
							case '2a1c':
								type = 'CFX';
								gDevices[addr]['symbol'] = 'C';
								break;
							case '6e400003b5a3f393e0a9e50e24dcca9e':
							default:
								type = 'XuXuKou';
								gDevices[addr]['symbol'] = 'X';
								break;
							}
							processSensorData(type, addr, data);
						});
					});
				});
			});
			// handle disconnect event
			peripheral.once('disconnect', function() {
				var address = peripheral.address;
				if (gDevices[address] == undefined)
					bleScan();
				else if (gDevices[address]['enabled']) {
					console.log(address + ' (RSSI: ' + gDevices[address]['rssi'] + ') disconnected on ' + new Date());
					gDevices[address]['enabled'] = false;
					gDevices[address]['connecting'] = false;
					bleScan();
				}
			});
		});
	}
});

process.on("SIGINT", function() {
	console.log('Receives SIGINT');
	disconnect(function() {
		// exit
		process.exit();
	});
});

function SendEmail(recipient, subject, body, callback) {
	// Use SMTP Protocol to send Email
	let transporter = nodemailer.createTransport({
		service: 'Gmail',
		auth: {
			type: 'login',
			user: 'chuangfeixin',
			pass: 'www.chuangfeixin.com'
		},
		debug: false // include SMTP traffic in the logs
	}, {
		// default message fields
		// sender info
		from: 'CFX <chuangfeixin@gmail.com>',
	});

	// Message object
	let message = {
		to: recipient,
		subject: subject,
		text: body,
		html: "<b>" + body + "</b>"
	}

	transporter.sendMail(message, (error, info) => {
		if (error) {
			console.log(error);
			callback(error);
			return;
		} else {
			callback(null);
			//console.log("Message sent: " + info.response);
		}
		transporter.close();
	});
}

function SendSMS(phoneInfo, subject, body, cb) {
	var gateways = {
		'AT&T': 'txt.att.net',
		'Sprint': 'messaging.sprintpcs.com',
		'T-Mobile': 'tmomail.net',
		'Verizon': 'vtext.com'};
	var carrier = phoneInfo['carrier'];
	var number = phoneInfo['number'];

	if (gateways[carrier] == undefined) {
		cb("invalid carrier " + carrier);
		return;
	}
	// normalize U.S. phone number
	if (number[0] == '+')
		number = number.substring(1);
	if (number[0] == '1')
		number = number.substring(1);

	if (number.length != 10) {
		cb("invalid phone number " + number);
		return;
	}
	recipient = number + '@' + gateways[carrier];
	SendEmail(recipient, subject, body, cb);
}

setInterval(function() {
	for (addr in gDevices) {
		if (gDevices[addr]['enabled']) {
			var peripheral = gDevices[addr]['peripheral'];
			peripheral.updateRssi(function(error, rssi) {
				if (!error) {
					gDevices[addr]['rssi'] = rssi;
				}
			});
		// if the connecting state stuck for 30s
		} else if (gDevices[addr]['connecting'] && ((new Date()).getTime() - gDevices[addr]['tsconn'] > 30 * 1000)) {
			gDevices[addr]['peripheral'].disconnect(function() {
				//console.log("disconnect", addr, "after no activity for 30s");
			});
		}
	}
	bleScan();
}, 1000);

// handle MQTT management
mqsh.input_sub(os.hostname(), function(sub) {
	sub.stdout.on('data', (data) => {
		execCmd(data.toString(), function(error, output) {
			//if (error)
			//	console.log(error);
			//console.log(output);
		});
	});
	sub.stderr.on('data', (data) => {
		console.log('error: ' + data.toString());
	});
	sub.on('close', (code) => {
		if (code)
			console.log('exit: ' + code);
	});
});

module.exports.simulate = simulate;
