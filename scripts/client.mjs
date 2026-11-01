import {io} from 'socket.io-client';
if(!process.env.ACCESS_TOKEN)throw new Error('Set ACCESS_TOKEN');
const socket=io(process.env.API_URL||'http://localhost:3000',{auth:{token:process.env.ACCESS_TOKEN}});
socket.on('notification',value=>console.log(JSON.stringify(value)));socket.on('connect_error',error=>console.error(error.message));
