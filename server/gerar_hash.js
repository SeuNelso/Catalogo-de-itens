const bcrypt = require('bcryptjs');

bcrypt.genSalt(10, function(err, salt) {
  bcrypt.hash('123', salt, function(err, hash) {
    console.log('Novo hash:', hash);
  });
}); 