# openshr-validation-tests
Black-box validation tests for the OpenSHR

Usage:
```
$ npm install
$ npm run test -- http://yourserver:8080/openmrs/ms/xdsrepository
```

By default a pix feed message will be sent to localhost:3602, but this can be changed via the `-p` flag:
```
$ npm run test -- -p yourserver:3602 http://yourserver:8080/openmrs/ms/xdsrepository
```
