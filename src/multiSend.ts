import { Interface } from '@ethersproject/abi'
import { Provider } from '@ethersproject/abstract-provider'
import { Signer } from '@ethersproject/abstract-signer'
import { BigNumber } from '@ethersproject/bignumber'
import { hexDataLength } from '@ethersproject/bytes'
import { Contract, Overrides } from '@ethersproject/contracts'
import { pack } from '@ethersproject/solidity'

import { ModuleTransaction, Operation, TransactionInput } from './types'

const MULTI_SEND_ABI = ['function multiSend(bytes memory transactions)']
const AVATAR_ABI = [
  'function execTransactionFromModule(address payable to,uint256 value,bytes calldata data, uint8 operation) external returns (bool success)',
]
const MULTI_SEND_CONTRACT_ADDRESS = '0x8D29bE29923b68abfDD21e541b9374737B49cdAD'

const coerceTransactionInput = (tx: TransactionInput): ModuleTransaction => ({
  operation: tx.operation || Operation.CALL,
  to: tx.to,
  value: tx.value || BigNumber.from(0),
  data: tx.data || '0x',
})

/// Encodes the transaction as packed bytes of:
/// - `operation` as a `uint8` with `0` for a `call` or `1` for a `delegatecall` (=> 1 byte),
/// - `to` as an `address` (=> 20 bytes),
/// - `value` as a `uint256` (=> 32 bytes),
/// -  length of `data` as a `uint256` (=> 32 bytes),
/// - `data` as `bytes`.
const encodePacked = (transactionInput: TransactionInput) => {
  const tx = coerceTransactionInput(transactionInput)
  return pack(
    ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
    [
      tx.operation || Operation.CALL,
      tx.to,
      tx.value || BigNumber.from(0),
      hexDataLength(tx.data),
      tx.data,
    ]
  )
}

const remove0x = (hexString: string) => hexString.substr(2)

// Encodes a batch of module transactions into a single multiSend module transaction.
// A module transaction is an object with fields corresponding to a Gnosis Safe's (i.e., Zodiac IAvatar's) `execTransactionFromModule` method parameters.
// For more information refer to https://docs.gnosis.io/safe/docs/contracts_details/#gnosis-safe-transactions.
export const encodeMultiSend = (
  transactions: readonly TransactionInput[],
  multiSendContractAddress: string = MULTI_SEND_CONTRACT_ADDRESS
): ModuleTransaction => {
  const multiSendContract = new Interface(MULTI_SEND_ABI)

  const transactionsEncoded =
    '0x' + transactions.map(encodePacked).map(remove0x).join('')
  const data = multiSendContract.encodeFunctionData('multiSend', [
    transactionsEncoded,
  ])

  return {
    operation: Operation.DELEGATE_CALL,
    to: multiSendContractAddress || MULTI_SEND_CONTRACT_ADDRESS,
    value: BigNumber.from(0),
    data,
  }
}

export class MultiSender extends Contract {
  readonly multiSendContractAddress: string

  constructor(
    avatarAddress: string,
    multiSendContractAddress: string = MULTI_SEND_CONTRACT_ADDRESS,
    providerOrSigner?: Provider | Signer
  ) {
    super(avatarAddress, AVATAR_ABI, providerOrSigner)
    this.multiSendContractAddress = multiSendContractAddress
  }

  async multiSend(
    transactions: readonly TransactionInput[],
    overrides: Overrides & { readonly from?: string | Promise<string> } = {}
  ) {
    let moduleTx: ModuleTransaction

    if (transactions.length === 1) {
      // Optimization: A single transaction doesn't need to be wrapped in a multi-send
      moduleTx = coerceTransactionInput(transactions[0])
    } else {
      moduleTx = encodeMultiSend(transactions, this.multiSendContractAddress)
    }

    return await this.execTransactionFromModule(
      moduleTx.to,
      moduleTx.value,
      moduleTx.data,
      moduleTx.operation,
      overrides
    )
  }
}
