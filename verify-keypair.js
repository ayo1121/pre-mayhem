// Quick script to verify keypair public key
const { Keypair } = require('@solana/web3.js');

const secretKey = [132,42,189,134,249,36,106,243,18,98,180,121,35,15,78,42,118,65,108,84,80,123,9,148,154,219,128,185,67,232,70,192,73,108,19,57,142,99,27,127,229,223,80,85,35,141,74,157,185,201,220,60,69,228,200,241,3,0,24,0,214,178,95,20];

const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

console.log('Public Key from keypair:', keypair.publicKey.toBase58());
console.log('');
console.log('Expected (user says):    5wcLxZ5mtjKjfk7Fgzb9nVvraFXFVtgNdtE5h1wgYSef');
console.log('Bot was using:           5wcLxZ5mtjkJfk7Fgzb9nVvraFXFVtgNdtE5h1wgYSef');
