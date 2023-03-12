import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import socketIO from 'socket.io';
import Tracer from 'tracer';
import morgan from 'morgan';

const supportedVersions = new Set(['1.0.0']);
const httpsEnabled = !!process.env.HTTPS;

const port = process.env.PORT || (httpsEnabled ? '443' : '9736');

const sslCertificatePath = process.env.SSLPATH || process.cwd();

const logger = Tracer.colorConsole({
	format: "{{timestamp}} <{{title}}> {{message}}"
});

const app = express();
let server: HttpsServer | Server;
if (httpsEnabled) {
	server = new HttpsServer({
		key: readFileSync(join(sslCertificatePath, 'privkey.pem')),
		cert: readFileSync(join(sslCertificatePath, 'fullchain.pem'))
	}, app);
} else {
	server = new Server(app);
}
const io = socketIO(server);

const clients = new Map<string, Client>();

interface Client {
	clientId: number;
}

interface Signal {
	data: string;
	to: string;
}

app.set('view engine', 'pug')
app.use(morgan('combined'))

let connectionCount = 0;
let address = process.env.ADDRESS;
if (!address) {
	logger.error('You must set the ADDRESS environment variable.');
	process.exit(1);
}

app.get('/', (_, res) => {
	res.render('index', { connectionCount, address });
});

app.get('/health', (req, res) => {
	res.json({
		uptime: process.uptime(),
		connectionCount,
		address,
		name: process.env.NAME
	});
})

function getRoomId(hostName: string, server: string, room: string) {
	return hostName + "-" + server + "-" + room;
}

io.use((socket, next) => {
	const userAgent = socket.request.headers['user-agent'];
	const matches = /^PenguinChat\/(\d+\.\d+\.\d+) \((\w+)\)$/.exec(userAgent);
	const error = new Error() as any;
	error.data = { message: 'The voice server does not support your version of PenguinChat.\nSupported versions: ' + Array.from(supportedVersions).join() };
	if (!matches) {
		next(error);
	} else {
		const version = matches[1];
		// const platform = matches[2];
		if (supportedVersions.has(version)) {
			next();
		} else {
			next(error);
		}
	}
});

io.on('connection', (socket: socketIO.Socket) => {
	connectionCount++;
	logger.info("Total connected: %d", connectionCount);
	let roomId: string | null = null;

	socket.on('join', (hostName: string, server: string, room: string, id: number) => {
		if (typeof hostName !== 'string' || typeof server !== 'string' || typeof room !== 'string' || typeof id !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid join command: %s %d %d`, socket.id, hostName, server, room, id);
			return;
		}

		let otherClients: any = {};
		roomId = getRoomId(hostName, server, room);
		if (io.sockets.adapter.rooms[roomId]) {
			let socketsInRoom = Object.keys(io.sockets.adapter.rooms[roomId].sockets);
			for (let s of socketsInRoom) {
				if (clients.has(s) && clients.get(s).clientId === id) {
					socket.disconnect();
					logger.error(`Socket %s sent invalid join command, attempted spoofing another client`);
					return;
				}
				if (s !== socket.id)
					otherClients[s] = clients.get(s);
			}
		}
		socket.join(roomId);
		socket.to(roomId).broadcast.emit('join', socket.id, {
			clientId: id
		});
		socket.emit('setClients', otherClients);
	});

	socket.on('id', (clientId: number) => {
		if (typeof clientId !== 'number') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command: %d %d`, socket.id, clientId);
			return;
		}
		let client = clients.get(socket.id);
		if (client != null && client.clientId != null && client.clientId !== clientId) {
			socket.disconnect();
			logger.error(`Socket %s sent invalid id command, attempted spoofing another client`);
			return;
		}
		client = {
			clientId: clientId
		};
		clients.set(socket.id, client);
		socket.to(roomId).broadcast.emit('setClient', socket.id, client);
	})


	socket.on('leave', () => {
		if (roomId) {
			socket.leave(roomId);
			clients.delete(socket.id);
		}
	})

	socket.on('signal', (signal: Signal) => {
		if (typeof signal !== 'object' || !signal.data || !signal.to || typeof signal.to !== 'string') {
			socket.disconnect();
			logger.error(`Socket %s sent invalid signal command: %j`, socket.id, signal);
			return;
		}
		const { to, data } = signal;
		io.to(to).emit('signal', {
			data,
			from: socket.id
		});
	});

	socket.on('disconnect', () => {
		clients.delete(socket.id);
		connectionCount--;
		logger.info("Total connected: %d", connectionCount);
	})

})

server.listen(port);
(async () => {
	logger.info('PenguinChat Server started: %s', address);
})();
