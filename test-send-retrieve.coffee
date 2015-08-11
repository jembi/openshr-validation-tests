fs = require 'fs'
uuid = require 'uuid'
request = require 'request'
stdio = require 'stdio'
xpath = require 'xpath'
dom = require('xmldom').DOMParser
eden = require 'node-eden'
oidgen = require 'oidgen'
net = require 'net'


actionPNR = 'urn:ihe:iti:2007:ProvideAndRegisterDocumentSet-b'
actionRetrieve = 'urn:ihe:iti:2007:RetrieveDocumentSet'

defaultRepositoryUniqueId = '1.19.6.24.109.42.1.5.1'

mllpStart = new Buffer [0x0B]
mllpEnd = new Buffer [0x1C, 0x0D]

sendRegistyHL7 = (hl7, callback) ->
  client = net.connect port: 3602, ->
    client.write mllpStart + hl7.replace(/\n/g, '\r') + mllpEnd

  response = new Buffer('')
  client.on 'data', (chunk) ->
    response += chunk
    if chunk.toString().indexOf(mllpEnd.toString()) isnt -1
      client.end()

  client.on 'end', ->
    if response.toString().indexOf("AA") isnt -1
      callback true
    else
      callback false

sendRepositoryRequest = (action, conf, reqBody, callback) ->
  options =
    url: conf.target
    headers:
      'content-type': "multipart/related; boundary=MIMEBoundaryurn_uuid_DCD262C64C22DB97351256303951323; type=\"application/xop+xml\"; start=\"<0.urn:uuid:DCD262C64C22DB97351256303951324@apache.org>\"; start-info=\"application/soap+xml\"; action=\"#{action}\""
    body: reqBody

  if conf.auth?
    options.auth = {}
    options.auth.user = conf.auth.split(':')[0]
    options.auth.pass = conf.auth.split(':')[1]

  request.post options, (err, res, body) ->
    return callback err if err
    return callback "Received response [#{res.statusCode}] #{body}" if res.statusCode isnt 200
    return callback 'empty response' if not body
    callback null, body


runTest = (testName, test, validator, conf, originalProvideRequest, body, callback) ->
  test conf, body, (err, response) ->
    if err
      console.log err
      callback false

    else if not validator originalProvideRequest, response
      console.log "#{testName}:\x1b[31m Failed\x1b[0m"
      console.log "\nResponse received: #{response}\n"
      callback false

    else
      console.log "#{testName}:\x1b[32m Successful\x1b[0m"
      callback true

provideAndRegister = (conf, reqBody, callback) -> sendRepositoryRequest actionPNR, conf, reqBody, callback

retrieveDocumentSet = (conf, reqBody, callback) -> sendRepositoryRequest actionRetrieve, conf, reqBody, callback


getXmlContent = (doc, name) ->
  i = doc.search new RegExp "<\\w*:?#{name}"
  if i < 0 then throw "Could not find xml content '#{name}'"

  doc = doc.substr i
  i = doc.search new RegExp "#{name}>"
  if i < 0 then throw "Could not find closing tag for '#{name}'"

  return doc.substr 0, i + "#{name}>".length


isPnRSuccessful = (originalProvideRequest, response) ->
  try
    # strip out the SOAP envelope from MIME
    response = getXmlContent response, 'Envelope'

    resDoc = new dom().parseFromString(response)
    status = xpath.useNamespaces({"rs": "urn:oasis:names:tc:ebxml-regrep:xsd:rs:3.0"})("//rs:RegistryResponse/@status", resDoc)
    return status?.length > 0 and status[0].value is 'urn:oasis:names:tc:ebxml-regrep:ResponseStatusType:Success'
  catch err
    console.log err
    return false

isRetrieveSuccessful = (originalProvideRequest, response) ->
  try
    originalCda = getXmlContent originalProvideRequest, 'ClinicalDocument'
    cda = getXmlContent response, 'ClinicalDocument'

    if cda isnt originalCda
      throw 'Retrieved document does not match'

    return true
  catch err
    console.log err
    return false


do ->
  ops = stdio.getopt
    auth:
      key: 'u'
      args: 1
      description: 'Basic auth username and password. Specify as username:password'
    'repo-unique-id':
      key: 'q'
      args: 1
      description: "The repository unique id to use. Default value is #{defaultRepositoryUniqueId}"

  if not ops.args or ops.args.length is 0
    console.log "Must specify target server\n"
    return ops.printHelp()

  conf =
    target: ops.args[0]
    docUniqueId: oidgen.random()
    subUniqueId: oidgen.random()
    sourcePatId: oidgen.random()
    messageId: uuid.v4()
    firstName: eden.eve()
    lastName: 'Patient'
    repoUniqueId: ops['repo-unique-id'] ? defaultRepositoryUniqueId

  console.log "Running with configuration: #{JSON.stringify conf, null, 2}\n"

  conf.auth = ops.auth

  processMsg = (doc) ->
    doc.replace /#{{docUniqueId}}/g, conf.docUniqueId
      .replace /#{{subUniqueId}}/g, conf.subUniqueId
      .replace /#{{sourcePatId}}/g, conf.sourcePatId
      .replace /#{{messageId}}/g, conf.messageId
      .replace /#{{repoUniqueId}}/g, conf.repoUniqueId
      .replace /#{{firstName}}/g, conf.firstName
      .replace /#{{lastName}}/g, conf.lastName
      .replace /#{{randomUUID}}/g, -> uuid.v4()

  provideDoc = processMsg fs.readFileSync('pnr-minimalIC.xml').toString()
  retrieveDoc = processMsg fs.readFileSync('retrieveDocumentSetb.xml').toString()
  adt = processMsg fs.readFileSync('adt_a01.er7').toString()

  sendRegistyHL7 adt, (success) ->
    if success
      runTest 'Provide and Register Document Set.b', provideAndRegister, isPnRSuccessful, conf, provideDoc, provideDoc, (success) ->
        if success
          runTest 'Retrieve Document Set.b', retrieveDocumentSet, isRetrieveSuccessful, conf, provideDoc, retrieveDoc, (success) ->
            if success
              process.exit 0
            else
              process.exit 1
        else
          process.exit 1
    else
      console.log 'Failed to register a patient with the XDS.b registry'
      process.exit 1
