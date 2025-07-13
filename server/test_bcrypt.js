const bcrypt = require('bcryptjs');

const senhaDigitada = '123';
const hashDoBanco = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZGHFQW1Yy1Q8v8y5rE6Q8p8Yy1Q8e'; // Cole aqui o hash do banco

const resultado = bcrypt.compareSync(senhaDigitada, hashDoBanco);
console.log('Senha confere?', resultado); 