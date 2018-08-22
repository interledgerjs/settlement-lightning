class InvalidFieldsError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'InvalidFieldsError'
  }
}

class TransferNotFoundError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'TransferNotFoundError'
  }
}

class MissingFulfillmentError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'MissingFulfillmentError'
  }
}

class NotAcceptedError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'NotAcceptedError'
  }
}

class AlreadyRolledBackError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'AlreadyRolledBackError'
  }
}

class AlreadyFulfilledError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'AlreadyFulfilledError'
  }
}

class DuplicateIdError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'DuplicateIdError'
  }
}

class TransferNotConditionalError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'TransferNotConditionalError'
  }
}

class RequestHandlerAlreadyRegisteredError extends Error {
  constructor () {
    super(...arguments)
    this.name = 'RequestHandlerAlreadyRegisteredError'
  }
}

module.exports = {
  AlreadyFulfilledError,
  AlreadyRolledBackError,
  InvalidFieldsError,
  TransferNotFoundError,
  TransferNotConditionalError,
  DuplicateIdError,
  MissingFulfillmentError,
  NotAcceptedError,
  RequestHandlerAlreadyRegisteredError
}
