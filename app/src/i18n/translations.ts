export const resources = {
  en: {
    translation: {
      appName: 'Supermarket TN', setup: 'Set up device', serverUrl: 'Customer server address',
      deviceName: 'Device name', activationCode: 'Activation code', waitingApproval: 'Waiting for approval…',
      login: 'Sign in', email: 'E-mail', password: 'Password', pin: 'Cashier PIN', totp: '2FA code',
      language: 'Language', license: { active: 'License active', warning: 'License renewal needed',
        readOnly: 'Read-only mode', unlicensed: 'License confirmation missing' },
    },
  },
  fr: {
    translation: {
      appName: 'Supermarket TN', setup: 'Configurer l’appareil', serverUrl: 'Adresse du serveur client',
      deviceName: 'Nom de l’appareil', activationCode: 'Code d’activation', waitingApproval: 'En attente de validation…',
      login: 'Se connecter', email: 'E-mail', password: 'Mot de passe', pin: 'PIN de caisse', totp: 'Code 2FA',
      language: 'Langue', license: { active: 'Licence active', warning: 'Renouvellement nécessaire',
        readOnly: 'Mode lecture seule', unlicensed: 'Confirmation de licence manquante' },
    },
  },
  ar: {
    translation: {
      appName: 'Supermarket TN', setup: 'إعداد الجهاز', serverUrl: 'عنوان خادم العميل',
      deviceName: 'اسم الجهاز', activationCode: 'رمز التفعيل', waitingApproval: 'في انتظار الموافقة…',
      login: 'تسجيل الدخول', email: 'البريد الإلكتروني', password: 'كلمة المرور', pin: 'رمز الصندوق', totp: 'رمز التحقق',
      language: 'اللغة', license: { active: 'الترخيص فعال', warning: 'يجب تجديد الترخيص',
        readOnly: 'وضع القراءة فقط', unlicensed: 'تأكيد الترخيص مفقود' },
    },
  },
} as const;
