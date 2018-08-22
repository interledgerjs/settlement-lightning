const BtpPacket = require('btp-packet');

function parse(data){
	return data.protocolData.map(packet => {
		switch(packet.contentType){
			case BtpPacket.MIME_APPLICATION_JSON:
				let pkt = Object.assign({},packet);
				pkt.data = JSON.parse(packet.data.toString());
				return pkt;
		}
	});
}

function composeJSONPacket (protocolName, data){
	return {
		protocolName: protocolName,
		contentType: BtpPacket.MIME_APPLICATION_JSON,
		data: Buffer.from(JSON.stringify(data))
	}	
}

module.exports = {parse: parse, composeJSONPacket,composeJSONPacket};