import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query,
} from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import {
  BarcodeCreate, PackagingCreate, ProductCreate, ProductDetailQuery, ProductPatch, ProductQuery,
} from './products.dto';
import { assertStoreAccess } from '../inventory/inventory.controller';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('stock.read')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(ProductQuery)) query: ProductQuery) {
    return this.products.list(ctx, query);
  }

  @Get('by-barcode/:code')
  @RequirePermission('stock.read')
  byBarcode(@Ctx() ctx: RequestContext, @Param('code') code: string) {
    return this.products.byBarcode(ctx, code);
  }

  /** Produktdetail mit Barcodes, Gebinden und – mit storeId – Bestand und Chargen (T-110). */
  @Get(':id')
  @RequirePermission('stock.read')
  detail(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(ProductDetailQuery)) q: ProductDetailQuery,
  ) {
    if (q.storeId) assertStoreAccess(ctx, q.storeId);
    return this.products.detail(ctx, id, q.storeId);
  }

  @Post()
  @RequirePermission('product.write')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(ProductCreate)) body: ProductCreate) {
    return this.products.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('product.write')
  update(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(ProductPatch)) body: ProductPatch,
  ) {
    return this.products.update(ctx, id, body);
  }

  @Post(':id/barcodes')
  @RequirePermission('product.write')
  addBarcode(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(BarcodeCreate)) body: BarcodeCreate,
  ) {
    return this.products.createBarcode(ctx, id, body);
  }

  @Delete(':id/barcodes/:code')
  @RequirePermission('product.write')
  removeBarcode(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('code') code: string,
  ) {
    return this.products.deleteBarcode(ctx, id, code);
  }

  @Post(':id/packagings')
  @RequirePermission('product.write')
  addPackaging(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PackagingCreate)) body: PackagingCreate,
  ) {
    return this.products.createPackaging(ctx, id, body);
  }
}
