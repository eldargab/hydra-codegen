import type {Entity, Model, Prop, JsonObject, Union, Enum} from "@subsquid/openreader/dist/model"
import {loadModel} from "@subsquid/openreader/dist/tools"
import {lowerCaseFirst, Output, unsupportedCase} from "@subsquid/openreader/dist/util"
import assert from "assert"
import {OutDir} from "./utils/outDir"


function generateOrmModels(model: Model, dir: OutDir): void {
    let variants = collectVariants(model)
    let index = dir.file('model.ts')
    let usesMarshaling = false

    for (let name in model) {
        let item = model[name]
        switch(item.kind) {
            case 'entity':
                generateEntity(name, item)
                break
            case 'object':
                generateObject(name, item)
                usesMarshaling = true
                break
            case 'union':
                generateUnion(name, item)
                break
            case 'enum':
                generateEnum(name, item)
                break
        }
    }

    index.write()
    if (usesMarshaling) {
        dir.addResource('marshal.ts')
    }

    function generateEntity(name: string, entity: Entity): void {
        index.line(`export * from "./model/${lowerCaseFirst(name)}.model"`)
        let out = dir.file(`model/${lowerCaseFirst(name)}.model.ts`)
        let imports = new ImportRegistry()
        imports.useTypeorm('Entity', 'Column', 'PrimaryColumn')
        out.lazy(() => imports.render(model))
        out.line()
        printComment(entity, out)
        out.line('@Entity_()')
        out.block(`export class ${name}`, () => {
            let first = true
            for (let key in entity.properties) {
                if (first) {
                    first = false
                } else {
                    out.line()
                }
                let prop = entity.properties[key]
                printComment(prop, out)
                switch(prop.type.kind) {
                    case 'scalar':
                        switch(prop.type.name) {
                            case 'ID':
                                out.line('@PrimaryColumn_()')
                                break
                            case 'String':
                                out.line(`@Column_("text", {nullable: ${prop.nullable}})`)
                                break
                            case 'Int':
                                out.line(`@Column_("integer", {nullable: ${prop.nullable}})`)
                                break
                            case 'Boolean':
                                out.line(`@Column_("bool", {nullable: ${prop.nullable}})`)
                                break
                            case 'DateTime':
                                out.line(`@Column_("timestamp with time zone", {nullable: ${prop.nullable}})`)
                                break
                            case 'BigInt':
                                out.line(`@Column_("numeric", {nullable: ${prop.nullable}})`)
                                break
                            case 'Bytes':
                                out.line(`@Column_("bytea", {nullable: ${prop.nullable}})`)
                                break
                            default:
                                throw unsupportedCase(prop.type.name)
                        }
                        break
                    case 'enum':
                        imports.useModel(prop.type.name)
                        out.line(`@Column_("varchar", {length: ${getEnumMaxLength(model, prop.type.name)}, nullable: ${prop.nullable}})`)
                        break
                    case 'fk':
                        imports.useTypeorm('ManyToOne', 'Index')
                        imports.useModel(prop.type.foreignEntity)
                        out.line('@Index_()')
                        out.line(`@ManyToOne_(() => ${prop.type.foreignEntity}, {nullable: ${prop.nullable}})`)
                        break
                    case 'list-relation':
                        imports.useTypeorm('OneToMany')
                        imports.useModel(prop.type.entity)
                        out.line(`@OneToMany_(() => ${prop.type.entity}, e => e.${prop.type.field})`)
                        break
                    case 'object':
                        imports.useModel(prop.type.name)
                        out.line(`@Column_("jsonb", {transformer: {to: obj => obj${prop.nullable ? '?' : ''}.toJSON(), from: json => ${prop.nullable ? 'json == null ? undefined : ' : ''}new ${prop.type.name}(json)}, nullable: ${prop.nullable}})`)
                        break
                    case 'union':
                        imports.useModel(prop.type.name)
                        out.line(`@Column_("jsonb", {transformer: {to: obj => obj${prop.nullable ? '?' : ''}.toJSON(), from: ${prop.nullable ? `json => json == null ? undefined : fromJson${prop.type.name}(json)` : `fromJson${prop.type.name}`}}, nullable: ${prop.nullable}})`)
                        break
                    default:
                        throw unsupportedCase(prop.type.kind)
                }
                out.line(`${key}!: ${getPropJsType('entity', prop)}`)
            }
        })
        out.write()
    }

    function generateObject(name: string, object: JsonObject): void {
        index.line(`export * from "./model/${lowerCaseFirst(name)}"`)
        let out = dir.file(`model/${lowerCaseFirst(name)}.ts`)
        let imports = new ImportRegistry()
        imports.useMarshal()
        imports.useAssert()
        out.lazy(() => imports.render(model))
        out.line()
        printComment(object, out)
        out.block(`export class ${name}`, () => {
            if (variants.has(name)) {
                out.line(`public readonly isTypeOf = '${name}'`)
            }
            for (let key in object.properties) {
                out.line(`private _${key}!: ${getPropJsType('object', object.properties[key])}`)
            }
            out.line()
            out.block(`constructor(json?: any)`, () => {
                out.block(`if (json != null)`, () => {
                    for (let key in object.properties) {
                        let prop = object.properties[key]
                        out.line(`this._${key} = ${marshalFromJson(prop, 'json.' + key)}`)
                    }
                })
            })
            for (let key in object.properties) {
                let prop = object.properties[key]
                out.line()
                printComment(prop, out)
                out.block(`get ${key}(): ${getPropJsType('object', prop)}`, () => {
                    if (!prop.nullable) {
                        out.line(`assert(this._${key} != null, 'uninitialized access')`)
                    }
                    out.line(`return this._${key}`)
                })
                out.line()
                out.block(`set ${key}(value: ${getPropJsType('object', prop)})`, () => {
                    out.line(`this._${key} = value`)
                })
            }
            out.line()
            out.block(`toJSON(): object`, () => {
                out.block('return', () => {
                    if (variants.has(name)) {
                        out.line('isTypeOf: this.isTypeOf,')
                    }
                    for (let key in object.properties) {
                        let prop = object.properties[key]
                        out.line(`${key}: ${marshalToJson(prop, 'this.' + key)},`)
                    }
                })
            })
        })
        out.write()

        function marshalFromJson(prop: Prop, exp: string): string {
            // assumes exp is a pure variable or prop access
            let convert: string
            switch(prop.type.kind) {
                case 'scalar':
                    convert = `marshal.${prop.type.name.toLowerCase()}.fromJSON(${exp})`
                    break
                case 'enum':
                case 'fk':
                    convert = `marshal.string.fromJSON(${exp})`
                    break
                case 'object':
                    convert = `new ${prop.type.name}(marshal.nonNull(${exp}))`
                    break
                case 'list':
                    convert = `marshal.fromList(${exp}, val => ${marshalFromJson(prop.type.item, 'val')})`
                    break
                default:
                    throw unsupportedCase(prop.type.kind)
            }
            if (prop.nullable) {
                convert = `${exp} == null ? undefined : ${convert}`
            }
            return convert
        }

        function marshalToJson(prop: Prop, exp: string): string {
            // assumes exp is a pure variable or prop access
            let convert: string
            switch(prop.type.kind) {
                case 'scalar':
                    switch(prop.type.name) {
                        case 'ID':
                        case 'String':
                        case 'Boolean':
                        case 'Int':
                        case 'Float':
                            return exp
                        default:
                            convert = `marshal.${prop.type.name.toLowerCase()}.toJSON(${exp})`
                    }
                    break
                case 'enum':
                case 'fk':
                    return exp
                case 'object':
                    convert = exp + '.toJSON()'
                    break
                case 'list':
                    convert = `${exp}.map(val => ${marshalFromJson(prop.type.item, 'val')})`
                    break
                default:
                    throw unsupportedCase(prop.type.kind)
            }
            if (prop.nullable) {
                convert = `${exp} == null ? undefined : ${convert}`
            }
            return convert
        }
    }

    function generateUnion(name: string, union: Union): void {
        index.line(`export * from "./model/${lowerCaseFirst(name)}"`)
        let out = dir.file(`model/${lowerCaseFirst(name)}.ts`)
        let imports = new ImportRegistry()
        out.lazy(() => imports.render(model))
        union.variants.forEach(v => imports.useModel(v))
        out.line()
        out.line(`export type ${name} = ${union.variants.join(' | ')}`)
        out.line()
        out.block(`export function fromJson${name}(json: any): ${name}`, () => {
            out.block(`switch(json?.isTypeOf)`, () => {
                union.variants.forEach(v => {
                    out.line(`case '${v}': return new ${v}(json)`)
                })
                out.line(`default: throw new TypeError('Unknown json object passed as ${name}')`)
            })
        })
        out.write()
    }

    function generateEnum(name: string, e: Enum): void {
        index.line(`export * from "./model/${lowerCaseFirst(name)}"`)
        let out = dir.file(`model/${lowerCaseFirst(name)}.ts`)
        out.block(`export enum ${name}`, () => {
            for (let val in e.values) {
                out.line(`${val} = "${val}",`)
            }
        })
        out.write()
    }
}


function getPropJsType(owner: 'entity' | 'object', prop: Prop): string {
    let type: string
    switch(prop.type.kind) {
        case 'scalar':
            type = getScalarJsType(prop.type.name)
            break
        case 'enum':
        case 'object':
        case 'union':
            type = prop.type.name
            break
        case 'fk':
            if (owner == 'entity') {
                type = prop.type.foreignEntity
            } else {
                type = 'string'
            }
            break
        case 'list':
            type = getPropJsType('object', prop.type.item)
            if (type.indexOf('|')) {
                type = `(${type})[]`
            } else {
                type += '[]'
            }
            break
        case 'list-relation':
            type = prop.type.entity + '[]'
            break
        default:
            throw unsupportedCase((prop.type as any).kind)
    }
    if (prop.nullable) {
        type += ' | undefined | null'
    }
    return type
}


function getScalarJsType(typeName: string): string {
    switch(typeName) {
        case 'ID':
        case 'String':
            return 'string'
        case 'Int':
        case 'Float':
            return 'number'
        case 'Boolean':
            return 'boolean'
        case 'DateTime':
            return 'Date'
        case 'BigInt':
            return 'bigint'
        case 'Bytes':
            return 'Buffer'
        default:
            throw unsupportedCase(typeName)
    }
}


function getEnumMaxLength(model: Model, enumName: string): number {
    let e = model[enumName]
    assert(e.kind == 'enum')
    return Object.keys(e.values).reduce((max, v) => Math.max(max, v.length), 0)
}


function collectVariants(model: Model): Set<string> {
    let variants = new Set<string>()
    for (let name in model) {
        let item = model[name]
        if (item.kind == 'union') {
            item.variants.forEach(v => variants.add(v))
        }
    }
    return variants
}


function printComment(obj: {description?: string}, out: Output) {
    if (obj.description) {
        let lines = obj.description.split('\n')
        out.line(`/**`)
        lines.forEach(line => out.line(' * ' + line)) // FIXME: escaping
        out.line(' */')
    }
}


class ImportRegistry {
    private typeorm = new Set<string>()
    private model = new Set<string>()
    private marshal = false
    private assert = false

    useTypeorm(...names: string[]): void {
        names.forEach(name => this.typeorm.add(name))
    }

    useModel(...names: string[]): void {
        names.forEach(name => this.model.add(name))
    }

    useMarshal() {
        this.marshal = true
    }

    useAssert() {
        this.assert = true
    }

    render(model: Model): string[] {
        let imports: string[] = []
        if (this.assert) {
            imports.push('import assert from "assert"')
        }
        if (this.typeorm.size > 0) {
            let importList = Array.from(this.typeorm).map(name => name + ' as ' + name + '_')
            imports.push(`import {${importList.join(', ')}} from "typeorm"`)
        }
        if (this.marshal) {
            imports.push(`import * as marshal from "../marshal"`)
        }
        for (let name of this.model) {
            switch(model[name].kind) {
                case 'entity':
                    imports.push(`import {${name}} from "./${lowerCaseFirst(name)}.model"`)
                    break
                default:
                    let names = [name]
                    if (model[name].kind == 'union') {
                        names.push('fromJson' + name)
                    }
                    imports.push(`import {${names.join(', ')}} from "./${lowerCaseFirst(name)}"`)
            }
        }
        return imports
    }
}


function main() {
    let model = loadModel('schema.graphql')
    let dir = new OutDir('src/generated')
    dir.del()
    dir.addResource('ormconfig.ts')
    generateOrmModels(model, dir)
}


if (require.main === module) {
    main()
}
