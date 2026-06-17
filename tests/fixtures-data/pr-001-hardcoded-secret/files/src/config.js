module.exports = {
  port: process.env.PORT || 3000,
  db: {
    host: 'prod-db.internal',
    password: 'Sup3rS3cr3tP@ssw0rd!',
  },
  stripe: {
    secretKey: 'sk_live_4eC39HqLyjWDarjtT1zdp7dc',
    webhookSecret: 'whsec_abcdefghijklmnopqrstuvwxyz1234567890AB',
  },
  aws: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE1',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  },
}
