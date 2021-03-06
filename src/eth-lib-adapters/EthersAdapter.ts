import EthLibAdapter, { Contract } from './EthLibAdapter';
import {
  TransactionResult, CallOptions, SendOptions, EthCallTx, formatCallTx, EthSendTx, normalizeGasLimit
} from '../utils/transactions';
import { zeroAddress, Address, Abi } from '../utils/constants';

interface EthersAdapterConfig {
  ethers: any;
  signer: any;
}

interface EthersTransactionResult extends TransactionResult {
  transactionResponse: object;
}

class EthersContractAdapter implements Contract {
  constructor(public contract: any, public ethersAdapter: EthersAdapter) {}

  get address(): Address {
    return this.contract.address;
  }

  async call(methodName: string, params: any[], options?: CallOptions): Promise<any> {
    const data = this.encode(methodName, params);
    const resHex = await this.ethersAdapter.ethCall({
      ...options,
      to: this.address,
      data,
    }, 'latest');
    const rets = this.contract.interface.functions[methodName].decode(resHex);

    if (rets.length === 1)
      return rets[0];

    return rets;
  }

  async send(
    methodName: string,
    params: any[],
    options?: SendOptions,
  ): Promise<EthersTransactionResult> {
    let transactionResponse;
    if (options != null) {
      const { from, gas, ...sendOptions } = normalizeGasLimit(options);
      await this.ethersAdapter.checkFromAddress(from);
      transactionResponse = await this.contract.functions[methodName](
        ...params,
        { gasLimit: gas, ...sendOptions },
      );
    } else {
      transactionResponse = await this.contract.functions[methodName](
        ...params,
      );
    }
    return { transactionResponse, hash: transactionResponse.hash };
  }

  async estimateGas(methodName: string, params: any[], options?: CallOptions): Promise<number> {
    if (!options) {
      return (await this.contract.estimate[methodName](...params)).toNumber();
    } else {
      const { gas, ...callOptions } = normalizeGasLimit(options);
      return (await this.contract.estimate[methodName](
        ...params,
        { gasLimit: gas, ...callOptions },
      )).toNumber();
    }
  }

  encode(methodName: string, params: any[]): string {
    return this.contract.interface.functions[methodName].encode(params);
  }
}

class EthersAdapter extends EthLibAdapter {
  ethers: any;
  signer: any;

  constructor({ ethers, signer }: EthersAdapterConfig) {
    super();

    if (!ethers) {
      throw new Error('ethers property missing from options');
    }
    if (!signer) {
      throw new Error('signer property missing from options');
    }
    this.ethers = ethers;
    this.signer = signer;
  }

  getProvider(): any {
    // eslint-disable-next-line no-underscore-dangle
    return this.signer.provider.provider || this.signer.provider._web3Provider;
  }

  providerSend(method: string, params: any[]): Promise<any> {
    return this.signer.provider.send(method, params);
  }

  async getNetworkId(): Promise<number> {
    return (await this.signer.provider.getNetwork()).chainId;
  }

  async getAccount(): Promise<Address> {
    return this.signer.getAddress();
  }

  keccak256(data: string): string {
    return this.ethers.utils.keccak256(data);
  }

  abiEncode(types: string[], values: any[]): string {
    return this.ethers.utils.defaultAbiCoder.encode(types, values);
  }

  abiDecode(types: string[], data: string): any[] {
    return this.ethers.utils.defaultAbiCoder.decode(types, data);
  }

  getContract(abi: Abi, address?: Address): Contract {
    const contract = new this.ethers.Contract(address || zeroAddress, abi, this.signer);
    return new EthersContractAdapter(contract, this);
  }

  calcCreate2Address(deployer: Address, salt: string, initCode: string): string {
    return this.ethers.utils.getAddress(
      this.ethers.utils.solidityKeccak256(['bytes', 'address', 'bytes32', 'bytes32'], [
        '0xff',
        deployer,
        salt,
        this.keccak256(initCode),
      ]).slice(-40),
    );
  }

  getCode(address: Address): Promise<string> {
    return this.signer.provider.getCode(address);
  }

  getBlock(blockHashOrBlockNumber: string | number): Promise<{ [property: string]: any }> {
    return this.signer.provider.getBlock(blockHashOrBlockNumber);
  }

  async getCallRevertData(tx: EthCallTx, block: string | number): Promise<string> {
    try {
      // Handle Geth/Ganache --noVMErrorsOnRPCResponse revert data
      return await this.ethCall(tx, block);
    } catch (e) {
      if (typeof e.data === 'string' && e.data.startsWith('Reverted 0x')) {
        // handle OpenEthereum revert data format
        return e.data.slice(9);
      }

      // handle Ganache revert data format
      const txHash = Object.getOwnPropertyNames(e.data).filter((k) => k.startsWith('0x'))[0];
      return e.data[txHash].return;
    }
  }

  ethCall(
    tx: EthCallTx,
    block: number | string,
  ): Promise<string> {
    // This is to workaround https://github.com/ethers-io/ethers.js/issues/819
    return this.providerSend('eth_call', [
      formatCallTx(tx),
      block,
    ]);
  }

  async checkFromAddress(from: Address): Promise<void> {
    const { getAddress } = this.ethers.utils;
    const expectedFrom = await this.getAccount();
    if (getAddress(from) !== expectedFrom) {
      throw new Error(`want from ${expectedFrom} but got from ${from}`);
    }
  }

  async ethSendTransaction(tx: EthSendTx): Promise<EthersTransactionResult> {
    const { from, gas, ...sendTx } = normalizeGasLimit(tx);
    await this.checkFromAddress(from);
    const transactionResponse = await this.signer.sendTransaction({ gasLimit: gas, ...sendTx });
    return { transactionResponse, hash: transactionResponse.hash };
  }

  getSendOptions(ownerAccount: Address, options?: CallOptions): SendOptions {
    return {
      from: ownerAccount,
      ...options,
    };
  }
}

export default EthersAdapter;
