import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma/prisma.service';
import { InitTransactionDTO, InputExecuteTransactionDTO } from './order.dto';
import { OrderStatus, OrderType } from '@prisma/client';
import { ClientKafka } from '@nestjs/microservices';

@Injectable()
export class OrdersService {
  constructor(
    private prismaService: PrismaService,
    @Inject('ORDERS_PUBLISHER') private readonly kafkaClient: ClientKafka,
  ) {}

  all(filter: { wallet_id: string }) {
    return this.prismaService.order.findMany({
      where: { wallet_id: filter.wallet_id },
      include: {
        Transactions: true,
        Asset: {
          select: {
            id: true,
            symbol: true,
          },
        },
      },
    });
  }

  async initTransaction(transaction: InitTransactionDTO) {
    const order = await this.prismaService.order.create({
      data: {
        asset_id: transaction.asset_id,
        wallet_id: transaction.wallet_id,
        shares: transaction.shares,
        partial: transaction.shares,
        price: transaction.price,
        type: transaction.type,
        status: OrderStatus.PENDING,
        version: 1,
      },
    });
    this.kafkaClient.emit('input', {
      order_id: order.id,
      investor_id: order.wallet_id,
      asset_id: order.asset_id,
      shares: order.shares,
      price: order.price,
      order_type: order.type,
    });

    return order;
  }

  async executeTransaction(input: InputExecuteTransactionDTO) {
    return this.prismaService.$transaction(async (prisma) => {
      const order = await this.prismaService.order.findUniqueOrThrow({
        where: { id: input.order_id },
      });
      await prisma.order.update({
        where: { id: input.order_id, version: order.version },
        data: {
          partial: order.partial - input.negotiated_shares,
          status: input.status,
          Transactions: {
            create: {
              broker_transaction_id: input.broker_transaction_id,
              related_investor_id: input.related_investor_id,
              shares: input.negotiated_shares,
              price: input.price,
            },
          },
          version: { increment: 1 },
        },
      });
      if (input.status === OrderStatus.CLOSED) {
        await prisma.asset.update({
          where: { id: order.asset_id },
          data: {
            price: input.price,
          },
        });
        const walletAsset = await prisma.walletAsset.findUnique({
          where: {
            wallet_id_asset_id: {
              asset_id: order.asset_id,
              wallet_id: order.wallet_id,
            },
          },
        });
        if (walletAsset) {
          await prisma.walletAsset.update({
            where: {
              wallet_id_asset_id: {
                asset_id: order.asset_id,
                wallet_id: order.wallet_id,
              },
              version: order.version,
            },
            data: {
              shares:
                order.type === OrderType.BUY
                  ? walletAsset.shares + order.shares
                  : walletAsset.shares - order.shares,
              version: { increment: 1 },
            },
          });
        } else {
          await prisma.walletAsset.create({
            data: {
              asset_id: order.asset_id,
              wallet_id: order.wallet_id,
              shares: order.shares,
              version: 1,
            },
          });
        }
      }
    });
  }
}
