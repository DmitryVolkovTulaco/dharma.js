import { Web3Utils } from "../../../utils/web3_utils";

import { DebtOrderParams } from "../../loan/debt_order";

import { Dharma } from "../dharma";

import {
    DebtOrderData,
    ECDSASignature,
    EthereumAddress,
    InterestRate,
    TimeInterval,
    TokenAmount,
} from "../";

import { SignedPrice } from "./signed_price";

import { BigNumber } from "../../../utils/bignumber";

export interface LTVData {
    principal: TokenAmount;
    interestRate: InterestRate;
    termLength: TimeInterval;
    expiresIn: TimeInterval;
    ltv: BigNumber;
    collateralTokenSymbol: string;
    priceProvider: string;
    relayer: EthereumAddress;
    relayerFee: TokenAmount;
}

export interface LTVParams extends DebtOrderParams {
    ltv: number;
    collateralTokenSymbol: string;
    priceProvider: string;
}

export interface CreditorCommmitmentTerms {
    decisionEngineAddress: string;
    decisionEngineParams: DecisionEngineParams;
}

export interface DecisionEngineParams {
    ltv: BigNumber;
}

export class LTVLoanOffer {
    public static decisionEngineAddress = "test";

    private readonly data: LTVData;

    private creditorSignature?: ECDSASignature;
    private debtorSignature?: ECDSASignature;
    private collateralAmount?: number;
    private principalPrice?: SignedPrice;
    private collateralPrice?: SignedPrice;

    constructor(private readonly dharma: Dharma, params: LTVParams) {
        const {
            ltv,
            priceProvider,
            collateralTokenSymbol,
            principalAmount,
            principalToken,
            relayerAddress,
            relayerFeeAmount,
            interestRate,
            termDuration,
            termUnit,
            expiresInDuration,
            expiresInUnit,
        } = params;

        this.data = {
            principal: new TokenAmount(principalAmount, principalToken),
            interestRate: new InterestRate(interestRate),
            termLength: new TimeInterval(termDuration, termUnit),
            expiresIn: new TimeInterval(expiresInDuration, expiresInUnit),
            ltv: new BigNumber(ltv),
            relayer: new EthereumAddress(relayerAddress),
            relayerFee: new TokenAmount(relayerFeeAmount, principalToken),
            collateralTokenSymbol,
            priceProvider,
        };
    }

    /**
     * Eventually signs the loan offer as the creditor.
     *
     * @throws Throws if the loan offer is already signed by a creditor.
     *
     * @example
     * loanOffer.signAsCreditor();
     * => Promise<void>
     *
     * @return {Promise<void>}
     */
    public async signAsCreditor(creditorAddress?: string): Promise<void> {
        if (this.isSignedByCreditor()) {
            throw new Error(DEBT_ORDER_ERRORS.ALREADY_SIGNED_BY_CREDITOR);
        }

        this.data.creditor = await EthereumAddress.validAddressOrCurrentUser(
            this.dharma,
            creditorAddress,
        );

        const loanOfferHash = this.getCreditorCommitmentHash();

        const isMetaMask = !!this.dharma.web3.currentProvider.isMetaMask;

        this.data.creditorSignature = await this.dharma.sign.signPayloadWithAddress(
            loanOfferHash,
            this.data.creditor,
            isMetaMask,
        );
    }

    public setPrincipalPrice(principalPrice: SignedPrice) {
        // TODO: assert signed address matches principal token address
        // TODO: assert signed price feed provider address is the address we expect
        // TODO: assert signed time is within some delta of current time (?)
        this.principalPrice = principalPrice;
    }

    public getPrincipalPrice(): SignedPrice {
        return this.principalPrice;
    }

    public setCollateralPrice(collateralPrice: SignedPrice) {
        // TODO: assert signed address matches collateral token address
        // TODO: assert signed price feed provider address is the address we expect
        // TODO: assert signed time is within some delta of current time (?)
        this.collateralPrice = collateralPrice;
    }

    public getCollateralPrice(): SignedPrice {
        return this.principalPrice;
    }

    public setCollateralAmount(collateralAmount: number) {
        // TODO: assert prices are set
        // TODO: assert collateralAmount sufficient
        this.collateralAmount = collateralAmount;
    }

    public getCollateralAmount(): number {
        return this.collateralAmount;
    }

    public getCreditorCommitmentTermsHash(): string {
        return Web3Utils.soliditySHA3(
            this.data.kernelVersion,
            this.data.issuanceVersion,
            this.data.termsContract,
            this.data.principalAmount,
            this.data.principalToken,
            this.data.collateralToken,
            this.data.ltv,
            this.data.interestRate,
            this.data.debtorFee,
            this.data.creditorFee,
            this.data.relayer,
            this.data.relayerFee,
            this.data.expirationTimestampInSec,
            this.data.salt,
        );
    }

    public getCreditorCommitmentHash(): string {
        return Web3Utils.soliditySHA3(
            LTVLoanOffer.decisionEngineAddress,
            this.getCreditorCommitmentTermsHash(),
        );
    }
}