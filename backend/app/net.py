"""Vérification TLS sortante basée sur le magasin de certificats du système.

Sous Windows, Python/httpx (via certifi) ne connaît pas les CA du magasin
Windows (contrairement à curl/navigateur), d'où des erreurs
CERTIFICATE_VERIFY_FAILED. `truststore` fait utiliser le magasin de l'OS.
"""

import ssl

import truststore

truststore.inject_into_ssl()

# Contexte TLS partagé (magasin OS) à passer aux clients httpx via verify=.
CA_BUNDLE = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
