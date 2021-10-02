import type {Entity, Model, Prop, JsonObject} from "@subsquid/openreader/dist/model"
import {loadModel} from "@subsquid/openreader/dist/tools"
import {lowerCaseFirst, Output} from "@subsquid/openreader/dist/util"
import assert from "assert"
import {OutDir} from "./utils/outDir"


function generateOrmModels(model: Model, dir: OutDir): void {
    let index = dir.file('model/index.ts')

    for (let name in model) {
        let item = model[name]
        switch(item.kind) {
            case 'entity':
                generateEntity(name, item)
                break
            case 'object':
                generateObject(name, item)
                break
        }
    }

    index.write()

    function generateEntity(name: string, entity: Entity): void {
        index.line(`export * from "./${lowerCaseFirst(name)}.model"`)
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
                        generateScalarColumn(key, prop, out)
                        break
                    case 'fk':
                        imports.useTypeorm('ManyToOne', 'Index')
                        imports.useModel(prop.type.foreignEntity)
                        out.line('@Index_()')
                        out.line(`@ManyToOne_(() => ${prop.type.foreignEntity})`)
                        out.line(`${key}!: ${printType(prop.type.foreignEntity, prop)}`)
                        break
                    case 'list-relation':
                        imports.useTypeorm('OneToMany')
                        imports.useModel(prop.type.entity)
                        out.line(`@OneToMany_(() => ${prop.type.entity}, e => e.${prop.type.field})`)
                        out.line(`${key}!: ${prop.type.entity}[]`)
                        break
                }
            }
        })
        out.write()
    }

    function generateObject(name: string, object: JsonObject): void {

    }
}


function generateScalarColumn(key: string, prop: Prop, out: Output): void {
    assert(prop.type.kind == 'scalar')
    switch(prop.type.name) {
        case 'ID':
            out.line('@PrimaryColumn_()')
            out.line('id!: string')
            break
        case 'String':
            out.line('@Column_("text")')
            out.line(`${key}!: ${printType('string', prop)}`)
            break
        case 'Int':
            out.line('@Column_("integer")')
            out.line(`${key}!: ${printType('number', prop)}`)
            break
        case 'Boolean':
            out.line('@Column_("bool")')
            out.line(`${key}!: ${printType('boolean', prop)}`)
            break
        case 'DateTime':
            out.line('@Column_("timestamp with time zone")')
            out.line(`${key}!: ${printType('Date', prop)}`)
            break
        case 'BigInt':
            out.line('@Column_("numeric")')
            out.line(`${key}!: ${printType('bigint', prop)}`)
            break
    }
}


function printType(name: string, prop: Prop): string {
    if (prop.nullable) {
        return name + ' | undefined | null'
    } else {
        return name
    }
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

    useTypeorm(...names: string[]): void {
        names.forEach(name => this.typeorm.add(name))
    }

    useModel(...names: string[]): void {
        names.forEach(name => this.model.add(name))
    }

    render(model: Model): string[] {
        let imports: string[] = []
        if (this.typeorm.size > 0) {
            let importList = Array.from(this.typeorm).map(name => name + ' as ' + name + '_')
            imports.push(`import {${importList.join(', ')}} from "typeorm"`)
        }
        for (let name of this.model) {
            switch(model[name].kind) {
                case 'entity':
                    imports.push(`import {${name}} from "./${lowerCaseFirst(name)}.model"`)
                    break
                default:
                    imports.push(`import {${name}} from "./${lowerCaseFirst(name)}"`)
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
