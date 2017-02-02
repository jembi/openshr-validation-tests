'use strict'

const fs = require('fs')
const path = require('path')
const tap = require('tap')
const uuid = require('uuid/v4')
const stdio = require('stdio')
const request = require('request')
const crypto = require('crypto')
const _ = require('lodash')
const moment = require('moment')
const faker = require('faker')
const chalk = require('chalk')

const mustache = require('mustache')
// disable html escaping
mustache.escape = (v) => v

const appOps = {
  host: {
    key: 'h',
    args: 1,
    description: 'Base URL to post to',
    default: 'http://localhost:3447/fhir'
  },
  'enable-auth': {
    key: 'a',
    description: 'Enable authentication (only applicable for Hearth servers)'
  },
  username: {
    key: 'u',
    args: 1,
    description: 'Hearth username',
    default: 'sysadmin@jembi.org'
  },
  password: {
    key: 'p',
    args: 1,
    description: 'Hearth password',
    default: 'sysadmin'
  }
}

const die = (err) => {
  console.error(`${chalk.red('ERROR')}`)
  console.error(err)
  process.exit(1)
}

// copy paste from
// https://github.com/jembi/hearth/blob/f5bc9bc1972903a99d74fc9f28f8452826f3ac96/test/test-env/init.js#L42
const getHearthAuthHeaders = (url, username, password, callback) => {
  request({
    url: `${url.replace('fhir', 'api')}/authenticate/${username}`,
    json: true
  }, (err, res, body) => {
    if (err) {
      return callback(err)
    }

    let passhash = crypto.createHash('sha512')
    passhash.update(body.salt)
    passhash.update(password)
    let tokenhash = crypto.createHash('sha512')
    tokenhash.update(passhash.digest('hex'))
    tokenhash.update(body.salt)
    tokenhash.update(body.ts)

    let auth = {
      'auth-username': username,
      'auth-ts': body.ts,
      'auth-salt': body.salt,
      'auth-token': tokenhash.digest('hex')
    }

    callback(null, auth)
  })
}

const loadResource = (filename, conf) => {
  const resPath = path.join(__dirname, 'test-samples', filename)
  const res = fs.readFileSync(resPath).toString()
  return mustache.render(res, conf)
}

const post = (host, resourceType, headers, body, onSuccess) => {
  const url = `${host}/${resourceType}`
  request.post({
    url: url,
    body: body,
    headers: headers
  }, (err, res, body) => {
    if (err) {
      console.error(`${chalk.red('ERROR')} POST ${url}`)
      die(err)
    }
    if (res.statusCode !== 201) {
      console.error(`${chalk.red('ERROR')} POST ${url}`)
      die(`Unexpected response: [${res.statusCode}] ${JSON.stringify(body)}`)
    }
    console.log(`${chalk.green('OK')} POST ${url}`)
    let reference
    if (res.headers.location) {
      reference = res.headers.location.replace(new RegExp(`.*(${resourceType}/\\w+)/_history/.*`), '$1')
    }
    onSuccess(reference, body)
  })
}

const MHDScenario = (ops, headers) => {
  const conf = {
    timeNow: moment().toISOString(),
    sourcePatId: uuid(),
    firstName: faker.name.firstName(1),
    lastName: faker.name.lastName(),
    docId: uuid(),
    manifestMID: uuid(),
    docManifestRef: `urn:uuid:${uuid()}`,
    docRefMID1: uuid(),
    docRef1: `urn:uuid:${uuid()}`,
    docRefMID2: uuid(),
    docRef2: `urn:uuid:${uuid()}`,
    binaryRef1: `urn:uuid:${uuid()}`,
    binaryRef2: `urn:uuid:${uuid()}`
  }

  let documentBundle

  const buildDocumentBundle = () => {
    const cda = loadResource('CDA-APHP-1.xml', conf)
    conf.cdaBase64 = Buffer.from(cda).toString('base64')

    const image = loadResource('Image-1.png', conf)
    conf.imageBase64 = Buffer.from(image).toString('base64')

    const binary1 = loadResource('Binary-1.json', conf)
    const binary2 = loadResource('Binary-2.json', conf)
    const docRef1 = loadResource('DocumentReference-1.json', conf)
    const docRef2 = loadResource('DocumentReference-2.json', conf)
    const docManifest = loadResource('DocumentManifest-1.json', conf)

    documentBundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        {
          fullUrl: conf.binaryRef1,
          resource: JSON.parse(binary1),
          request: {
            method: 'POST',
            url: 'Binary'
          }
        },
        {
          fullUrl: conf.binaryRef2,
          resource: JSON.parse(binary2),
          request: {
            method: 'POST',
            url: 'Binary'
          }
        },
        {
          fullUrl: conf.docRef1,
          resource: JSON.parse(docRef1),
          request: {
            method: 'POST',
            url: 'DocumentReference'
          }
        },
        {
          fullUrl: conf.docRef2,
          resource: JSON.parse(docRef2),
          request: {
            method: 'POST',
            url: 'DocumentReference'
          }
        },
        {
          fullUrl: conf.docManifestRef,
          resource: JSON.parse(docManifest),
          request: {
            method: 'POST',
            url: 'DocumentManifest'
          }
        }
      ]
    }

    documentBundle = JSON.stringify(documentBundle)
  }

  const iti65_provideDocumentBundle = (callback) => {
    tap.test('ITI-65 Provide Document Bundle', {bail: true}, (t) => {
      request.post({
        url: ops.host,
        body: documentBundle,
        headers: headers
      }, (err, res, body) => {
        t.error(err, `POST ${ops.host}`)
        t.equals(res.statusCode, 200, 'status code should be 200')

        body = JSON.parse(body)
        t.equals(body.resourceType, 'Bundle', 'resource type should be Bundle')
        t.equals(body.type, 'transaction-response', 'bundle type should be \'transaction-response\'')
        t.equals(body.entry.length, 5, 'response should contain 5 entries')
        for (let e of body.entry) {
          // response.status is unbounded, so responses like '201 Created' are possible
          // TODO OHIE-193
          // t.equals(e.response.status.substr(0, 3), '201', 'entry response status should be 201')

          if (e.response.location.indexOf('Binary') > -1) {
            const ref = e.response.location.replace(new RegExp('.*(Binary/\\w+)/_history/.*'), '$1')
            if (conf.binaryResource1) {
              conf.binaryResource2 = ref
            } else {
              conf.binaryResource1 = ref
            }
          }
        }
        t.end()
        callback()
      })
    })
  }

  const searchManifest = (t, path) => {
    const url = `${ops.host}/${path}`
    return new Promise((resolve) => {
      request({
        url: url,
        headers: headers
      }, (err, res, body) => {
        t.error(err, `GET ${url}`)
        t.equals(res.statusCode, 200, 'response status code should be 200')

        body = JSON.parse(body)
        t.equals(body.resourceType, 'Bundle', 'resource type should be Bundle')
        t.equals(body.type, 'searchset', 'bundle type should be \'searchset\'')

        t.equals(body.total, 1, 'searchset should contain 1 result')
        t.equals(body.entry[0].resource.resourceType, 'DocumentManifest', 'searchset should contain manifest')
        t.equals(body.entry[0].resource.masterIdentifier.value, conf.manifestMID, 'searchset should contain correct manifest')

        resolve()
      })
    })
  }

  const iti66_findDocumentManifests = (callback) => {
    tap.test('ITI-66 Find Document Manifests', {bail: true}, (t) => {
      const promises = []

      promises.push(searchManifest(t, `DocumentManifest?patient=${conf.patientRef}`))
      promises.push(searchManifest(t, `DocumentManifest?patient.identifier=${conf.sourcePatId}`))

      Promise.all(promises).then(() => {
        t.end()
        callback()
      })
    })
  }

  const searchReferences = (t, path) => {
    const url = `${ops.host}/${path}`
    return new Promise((resolve) => {
      request({
        url: url,
        headers: headers
      }, (err, res, body) => {
        t.error(err, `GET ${url}`)
        t.equals(res.statusCode, 200, 'response status code should be 200')

        body = JSON.parse(body)
        t.equals(body.resourceType, 'Bundle', 'resource type should be Bundle')
        t.equals(body.type, 'searchset', 'bundle type should be \'searchset\'')

        t.equals(body.total, 2, 'searchset should contain 1 result')
        t.equals(body.entry[0].resource.resourceType, 'DocumentReference', 'searchset should contain reference')
        t.equals(body.entry[0].resource.masterIdentifier.value, conf.docRefMID1, 'searchset should contain correct reference')
        t.equals(body.entry[1].resource.resourceType, 'DocumentReference', 'searchset should contain reference')
        t.equals(body.entry[1].resource.masterIdentifier.value, conf.docRefMID2, 'searchset should contain correct reference')

        resolve()
      })
    })
  }

  const iti67_findDocumentReferences = (callback) => {
    tap.test('ITI-67 Find Document References', {bail: true}, (t) => {
      const promises = []

      promises.push(searchReferences(t, `DocumentReference?patient=${conf.patientRef}`))
      promises.push(searchReferences(t, `DocumentReference?patient.identifier=${conf.sourcePatId}`))

      Promise.all(promises).then(() => {
        t.end()
        callback()
      })
    })
  }

  const fetchBinary = (t, path, expected) => {
    const url = `${ops.host}/${path}`
    return new Promise((resolve) => {
      request({
        url: url,
        headers: headers
      }, (err, res, body) => {
        t.error(err, `GET ${url}`)
        t.equals(res.statusCode, 200, 'response status code should be 200')

        body = JSON.parse(body)
        t.equals(body.resourceType, 'Binary', 'resource type should be Bundle')
        t.equals(body.content, expected, 'resource should contain correct content')

        resolve()
      })
    })
  }

  const iti68_retrieveDocument = (callback) => {
    tap.test('ITI-68 Retrieve Document', {bail: true}, (t) => {
      const promises = []

      promises.push(fetchBinary(t, conf.binaryResource1, conf.cdaBase64))
      promises.push(fetchBinary(t, conf.binaryResource2, conf.imageBase64))

      // TODO OHIE-191

      Promise.all(promises).then(() => {
        t.end()
        callback()
      })
    })
  }

  return {
    init: (callback) => {
      console.log(`Executing MHD tests against: ${ops.host}`)
      console.log()
      console.log('Initializing patient and practitioner')

      const patient = loadResource('Patient-1.json', conf)
      post(ops.host, 'Patient', headers, patient, (ref) => {
        conf.patientRef = ref
        const prac = loadResource('Practitioner-1.json', conf)
        post(ops.host, 'Practitioner', headers, prac, (ref) => {
          conf.providerRef = ref

          buildDocumentBundle()
          callback()
        })
      })
    },

    execute: (callback) => {
      console.log()
      console.log('Running MHD requests')
      console.log()
      console.log('Configuration:')
      for (let k in conf) {
        if (k !== 'cdaBase64' && k !== 'imageBase64') {
          console.log(`${k}: ${chalk.cyan(conf[k])}`)
        }
      }
      console.log()

      iti65_provideDocumentBundle(() => {
        iti66_findDocumentManifests(() => {
          iti67_findDocumentReferences(() => {
            iti68_retrieveDocument(() => {
              callback()
            })
          })
        })
      })
    }
  }
}

const runTests = (Scenario, ops, headers) => {
  const scenario = Scenario(ops, headers)
  scenario.init((err) => {
    if (err) {
      die(err)
    }

    scenario.execute((err) => {
      if (err) {
        die(err)
      }
    })
  })
}

(() => {
  const ops = stdio.getopt(appOps)
  const headers = {
    // TODO OHIE-192
    // 'content-type': 'application/json+fhir'
    'content-type': 'application/json'
  }

  if (ops.host[ops.length - 1] === '/') {
    ops.host = ops.host.slice(0, -1)
  }

  if (ops['enable-auth']) {
    getHearthAuthHeaders(ops.host, ops.username, ops.password, (err, auth) => {
      if (err) {
        die(err)
      }
      _.extend(headers, auth)
      runTests(MHDScenario, ops, headers)
    })
  } else {
    runTests(MHDScenario, ops, headers)
  }
})()
