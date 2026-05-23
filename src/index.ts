import { ChatRoom } from './lib/room';

export { ChatRoom };

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url);

		const roomId = url.pathname.split('/')[2];
		if (!roomId) {
			return new Response('Missing room ID', { status: 400 });
		}

		const id = env.CHAT_ROOM.idFromName(roomId);
		const stub = env.CHAT_ROOM.get(id);
		const newUrl = new URL('/websocket', request.url);
		const newReq = new Request(newUrl, request);
		return stub.fetch(newReq);
	},
};
